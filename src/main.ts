import ChainManager from "@/LLMProviders/chainManager";
import { LangChainParams, SetChainOptions } from "@/aiParams";
import { ChainType } from "@/chainFactory";
import { registerBuiltInCommands } from "@/commands";
import { AddPromptModal } from "@/components/AddPromptModal";
import { AdhocPromptModal } from "@/components/AdhocPromptModal";
import { ChatNoteContextModal } from "@/components/ChatNoteContextModal";
import CopilotView from "@/components/CopilotView";
import { ListPromptModal } from "@/components/ListPromptModal";
import {
  CHAT_VIEWTYPE,
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPT,
} from "@/constants";
import { CustomPrompt } from "@/customPromptProcessor";
import EncryptionService from "@/encryptionService";
import { CopilotSettingTab, CopilotSettings } from "@/settings/SettingsPage";
import SharedState from "@/sharedState";
import { sanitizeSettings } from "@/utils";
import VectorDBManager, { VectorStoreDocument } from "@/vectorDBManager";
import { Server } from "http";
import { Editor, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import PouchDB from "pouchdb";

export default class CopilotPlugin extends Plugin {
  settings: CopilotSettings;
  // A chat history that stores the messages sent and received
  // Only reset when the user explicitly clicks "New Chat"
  sharedState: SharedState;
  chainManager: ChainManager;
  activateViewPromise: Promise<void> | null = null;
  chatIsVisible = false;
  dbPrompts: PouchDB.Database;
  dbVectorStores: PouchDB.Database;
  encryptionService: EncryptionService;
  server: Server | null = null;

  isChatVisible = () => this.chatIsVisible;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new CopilotSettingTab(this.app, this));
    // Always have one instance of sharedState and chainManager in the plugin
    this.sharedState = new SharedState();
    const langChainParams = this.getChainManagerParams();
    this.encryptionService = new EncryptionService(this.settings);
    this.chainManager = new ChainManager(
      langChainParams,
      this.encryptionService
    );

    if (this.settings.enableEncryption) {
      await this.saveSettings();
    }

    this.dbPrompts = new PouchDB<CustomPrompt>("copilot_custom_prompts");

    this.dbVectorStores = new PouchDB<VectorStoreDocument>(
      "copilot_vector_stores"
    );

    VectorDBManager.initializeDB(this.dbVectorStores);
    // Remove documents older than TTL days on load
    VectorDBManager.removeOldDocuments(
      this.settings.ttlDays * 24 * 60 * 60 * 1000
    );

    this.registerView(
      CHAT_VIEWTYPE,
      (leaf: WorkspaceLeaf) => new CopilotView(leaf, this)
    );

    this.addCommand({
      id: "chat-toggle-window",
      name: "Toggle Copilot Chat Window",
      callback: () => {
        this.toggleView();
      },
    });

    this.addCommand({
      id: "chat-toggle-window-note-area",
      name: "Toggle Copilot Chat Window in Note Area",
      callback: () => {
        this.toggleViewNoteArea();
      },
    });

    this.addRibbonIcon("message-square", "Copilot Chat", (evt: MouseEvent) => {
      this.toggleView();
    });

    registerBuiltInCommands(this);

    this.addCommand({
      id: "add-custom-prompt",
      name: "Add custom prompt",
      editorCallback: (editor: Editor) => {
        new AddPromptModal(this.app, async (title: string, prompt: string) => {
          try {
            // Save the prompt to the database
            await this.dbPrompts.put({ _id: title, prompt: prompt });
            new Notice("Custom prompt saved successfully.");
          } catch (e) {
            new Notice(
              "Error saving custom prompt. Please check if the title already exists."
            );
            console.error(e);
          }
        }).open();
      },
    });

    this.addCommand({
      id: "apply-custom-prompt",
      name: "Apply custom prompt",
      editorCallback: (editor: Editor) => {
        this.fetchPromptTitles().then((promptTitles: string[]) => {
          new ListPromptModal(
            this.app,
            promptTitles,
            async (promptTitle: string) => {
              if (!promptTitle) {
                new Notice("Please select a prompt title.");
                return;
              }
              try {
                const doc = (await this.dbPrompts.get(
                  promptTitle
                )) as CustomPrompt;
                if (!doc.prompt) {
                  new Notice(
                    `No prompt found with the title "${promptTitle}".`
                  );
                  return;
                }
                this.processCustomPrompt(
                  editor,
                  "applyCustomPrompt",
                  doc.prompt
                );
              } catch (err) {
                if (err.name === "not_found") {
                  new Notice(
                    `No prompt found with the title "${promptTitle}".`
                  );
                } else {
                  console.error(err);
                  new Notice("An error occurred.");
                }
              }
            }
          ).open();
        });
      },
    });

    this.addCommand({
      id: "apply-adhoc-prompt",
      name: "Apply ad-hoc custom prompt",
      editorCallback: async (editor: Editor) => {
        const modal = new AdhocPromptModal(
          this.app,
          async (adhocPrompt: string) => {
            try {
              this.processCustomPrompt(editor, "applyAdhocPrompt", adhocPrompt);
            } catch (err) {
              console.error(err);
              new Notice("An error occurred.");
            }
          }
        );

        modal.open();
      },
    });

    this.addCommand({
      id: "delete-custom-prompt",
      name: "Delete custom prompt",
      checkCallback: (checking: boolean) => {
        if (checking) {
          return true;
        }

        this.fetchPromptTitles().then((promptTitles: string[]) => {
          new ListPromptModal(
            this.app,
            promptTitles,
            async (promptTitle: string) => {
              if (!promptTitle) {
                new Notice("Please select a prompt title.");
                return;
              }

              try {
                const doc = await this.dbPrompts.get(promptTitle);
                if (doc._rev) {
                  await this.dbPrompts.remove(
                    doc as PouchDB.Core.RemoveDocument
                  );
                  new Notice(`Prompt "${promptTitle}" has been deleted.`);
                } else {
                  new Notice(
                    `Failed to delete prompt "${promptTitle}": No revision found.`
                  );
                }
              } catch (err) {
                if (err.name === "not_found") {
                  new Notice(
                    `No prompt found with the title "${promptTitle}".`
                  );
                } else {
                  console.error(err);
                  new Notice("An error occurred while deleting the prompt.");
                }
              }
            }
          ).open();
        });

        return true;
      },
    });

    this.addCommand({
      id: "edit-custom-prompt",
      name: "Edit custom prompt",
      checkCallback: (checking: boolean) => {
        if (checking) {
          return true;
        }

        this.fetchPromptTitles().then((promptTitles: string[]) => {
          new ListPromptModal(
            this.app,
            promptTitles,
            async (promptTitle: string) => {
              if (!promptTitle) {
                new Notice("Please select a prompt title.");
                return;
              }

              try {
                const doc = (await this.dbPrompts.get(
                  promptTitle
                )) as CustomPrompt;
                if (doc.prompt) {
                  new AddPromptModal(
                    this.app,
                    (title: string, newPrompt: string) => {
                      this.dbPrompts.put({
                        ...doc,
                        prompt: newPrompt,
                      });
                      new Notice(`Prompt "${title}" has been updated.`);
                    },
                    doc._id,
                    doc.prompt,
                    true
                  ).open();
                } else {
                  new Notice(
                    `No prompt found with the title "${promptTitle}".`
                  );
                }
              } catch (err) {
                if (err.name === "not_found") {
                  new Notice(
                    `No prompt found with the title "${promptTitle}".`
                  );
                } else {
                  console.error(err);
                  new Notice("An error occurred.");
                }
              }
            }
          ).open();
        });

        return true;
      },
    });

    this.addCommand({
      id: "clear-local-vector-store",
      name: "Clear local vector store",
      callback: async () => {
        try {
          // Clear the vectorstore db
          await this.dbVectorStores.destroy();
          // Reinitialize the database
          this.dbVectorStores = new PouchDB<VectorStoreDocument>(
            "copilot_vector_stores"
          );
          // Make sure to update the instance with VectorDBManager
          VectorDBManager.updateDBInstance(this.dbVectorStores);
          new Notice("Local vector store cleared successfully.");
          console.log(
            "Local vector store cleared successfully, new instance created."
          );
        } catch (err) {
          console.error("Error clearing the local vector store:", err);
          new Notice(
            "An error occurred while clearing the local vector store."
          );
        }
      },
    });

    this.addCommand({
      id: "set-chat-note-context",
      name: "Set note context for Chat mode",
      callback: async () => {
        new ChatNoteContextModal(
          this.app,
          this.settings,
          async (path: string, tags: string[], removeFrontmatter: boolean) => {
            // Store the path in the plugin's settings, default to empty string
            this.settings.chatNoteContextPath = path;
            this.settings.chatNoteContextTags = tags;
            this.settings.removeFrontmatter = removeFrontmatter;
            await this.saveSettings();
          }
        ).open();
      },
    });
  }

  async processText(
    editor: Editor,
    eventType: string,
    eventSubtype?: string,
    checkSelectedText = true
  ) {
    const selectedText = editor.getSelection();

    const isChatWindowActive =
      this.app.workspace.getLeavesOfType(CHAT_VIEWTYPE).length > 0;

    if (!isChatWindowActive) {
      await this.activateView();
    }

    // Without the timeout, the view is not yet active
    setTimeout(() => {
      const activeCopilotView = this.app.workspace
        .getLeavesOfType(CHAT_VIEWTYPE)
        .find((leaf) => leaf.view instanceof CopilotView)?.view as CopilotView;
      if (activeCopilotView && (!checkSelectedText || selectedText)) {
        activeCopilotView.emitter.emit(eventType, selectedText, eventSubtype);
      }
    }, 0);
  }

  processSelection(editor: Editor, eventType: string, eventSubtype?: string) {
    this.processText(editor, eventType, eventSubtype);
  }

  processCustomPrompt(editor: Editor, eventType: string, customPrompt: string) {
    this.processText(editor, eventType, customPrompt, false);
  }

  toggleView() {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEWTYPE);
    leaves.length > 0 ? this.deactivateView() : this.activateView();
  }

  async activateView() {
    this.app.workspace.detachLeavesOfType(CHAT_VIEWTYPE);
    this.activateViewPromise = this.app.workspace.getRightLeaf(false)?.setViewState({
        type: CHAT_VIEWTYPE,
        active: true,
      }) ?? null;
    await this.activateViewPromise;
    this.app.workspace.revealLeaf(
      this.app.workspace.getLeavesOfType(CHAT_VIEWTYPE)[0]
    );
    this.chatIsVisible = true;
  }

  async deactivateView() {
    this.app.workspace.detachLeavesOfType(CHAT_VIEWTYPE);
    this.chatIsVisible = false;
  }

  async toggleViewNoteArea() {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEWTYPE);
    leaves.length > 0 ? this.deactivateView() : this.activateViewNoteArea();
  }

  async activateViewNoteArea() {
    this.app.workspace.detachLeavesOfType(CHAT_VIEWTYPE);
    this.activateViewPromise = this.app.workspace.getLeaf(true).setViewState({
      type: CHAT_VIEWTYPE,
      active: true,
    });
    await this.activateViewPromise;
    this.app.workspace.revealLeaf(
      this.app.workspace.getLeavesOfType(CHAT_VIEWTYPE)[0]
    );
    this.chatIsVisible = true;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    if (this.settings.enableEncryption) {
      // Encrypt all API keys before saving
      this.encryptionService.encryptAllKeys();
    }
    await this.saveData(this.settings);
  }

  async fetchPromptTitles(): Promise<string[]> {
    const response = await this.dbPrompts.allDocs({ include_docs: true });
    return response.rows
      .map((row) => (row.doc as CustomPrompt)?._id)
      .filter(Boolean) as string[];
  }

  getChainManagerParams(): LangChainParams {
    const {
      openAIApiKey,
      huggingfaceApiKey,
      cohereApiKey,
      anthropicApiKey,
      azureOpenAIApiKey,
      azureOpenAIApiInstanceName,
      azureOpenAIApiDeploymentName,
      azureOpenAIApiVersion,
      azureOpenAIApiEmbeddingDeploymentName,
      googleApiKey,
      openRouterAiApiKey,
      openRouterModel,
      embeddingModel,
      temperature,
      maxTokens,
      contextTurns,
      embeddingProvider,
      ollamaModel,
      ollamaBaseUrl,
      lmStudioBaseUrl,
    } = sanitizeSettings(this.settings);
    return {
      openAIApiKey,
      huggingfaceApiKey,
      cohereApiKey,
      anthropicApiKey,
      azureOpenAIApiKey,
      azureOpenAIApiInstanceName,
      azureOpenAIApiDeploymentName,
      azureOpenAIApiVersion,
      azureOpenAIApiEmbeddingDeploymentName,
      googleApiKey,
      openRouterAiApiKey,
      openRouterModel: openRouterModel || DEFAULT_SETTINGS.openRouterModel,
      ollamaModel: ollamaModel || DEFAULT_SETTINGS.ollamaModel,
      ollamaBaseUrl: ollamaBaseUrl || DEFAULT_SETTINGS.ollamaBaseUrl,
      lmStudioBaseUrl: lmStudioBaseUrl || DEFAULT_SETTINGS.lmStudioBaseUrl,
      model: this.settings.defaultModel,
      modelDisplayName: this.settings.defaultModelDisplayName,
      embeddingModel: embeddingModel || DEFAULT_SETTINGS.embeddingModel,
      temperature: Number(temperature),
      maxTokens: Number(maxTokens),
      systemMessage: this.settings.userSystemPrompt || DEFAULT_SYSTEM_PROMPT,
      chatContextTurns: Number(contextTurns),
      embeddingProvider: embeddingProvider,
      chainType: ChainType.LLM_CHAIN, // Set LLM_CHAIN as default ChainType
      options: { forceNewCreation: true } as SetChainOptions,
      openAIProxyBaseUrl: this.settings.openAIProxyBaseUrl,
      openAIProxyModelName: this.settings.openAIProxyModelName,
      openAIEmbeddingProxyBaseUrl: this.settings.openAIEmbeddingProxyBaseUrl,
      openAIEmbeddingProxyModelName:
        this.settings.openAIEmbeddingProxyModelName,
    };
  }
}
