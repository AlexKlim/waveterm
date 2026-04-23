// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { base64ToString, stringToBase64 } from "@/util/util";
import { CaptureUpdateAction, convertToExcalidrawElements, getSceneVersion, THEME } from "@excalidraw/excalidraw";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { loadable } from "jotai/utils";

import type { WaveEnv } from "@/app/waveenv/waveenv";
import { ExcalidrawView } from "./excalidraw";

const AutosaveDebounceMs = 1500;

export class ExcalidrawModel implements ViewModel {
    viewType = "excalidraw";
    blockId: string;
    nodeModel: BlockNodeModel;
    viewComponent: ViewComponent = ExcalidrawView;

    noPadding = atom(true);
    isDirtyAtom = atom(false) as PrimitiveAtom<boolean>;

    viewIcon!: Atom<string>;
    viewName!: Atom<string>;
    themeAtom!: Atom<string>;
    filePathAtom!: Atom<string>;
    sceneAtom!: Atom<Promise<any>>;
    loadableSceneAtom!: Atom<Loadable<any>>;
    errorMsgAtom!: PrimitiveAtom<ErrorMsg>;

    blockAtom!: Atom<Block>;

    private env: WaveEnv;
    private excalidrawAPI: any = null;
    private lastSavedVersion: number = 0;
    private pendingElements: readonly any[] = [];
    private pendingAppState: any = null;
    private pendingFiles: any = null;
    private pushSceneUnsubFn: (() => void) | null = null;
    private saveTimeoutId: ReturnType<typeof setTimeout> | null = null;
    private pendingPushScene: { elements: any[]; appState?: any; files?: any } | null = null;

    constructor({ blockId, nodeModel, waveEnv }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.env = waveEnv;

        this.blockAtom = waveEnv.wos.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.errorMsgAtom = atom(null) as PrimitiveAtom<ErrorMsg>;
        this.viewIcon = atom("pen-ruler");

        this.filePathAtom = atom((get) => {
            return get(this.blockAtom)?.meta?.file ?? null;
        });

        this.viewName = atom((get) => {
            const filePath = get(this.filePathAtom);
            const isDirty = get(this.isDirtyAtom);
            const name = filePath ? filePath.split("/").pop() ?? "Excalidraw" : "Excalidraw";
            return isDirty ? `${name} *` : name;
        });

        this.themeAtom = atom(() => {
            return THEME.DARK;
        });

        this.sceneAtom = atom(async (get) => {
            const filePath = get(this.filePathAtom);
            if (!filePath) {
                return null;
            }
            try {
                const fileData = await waveEnv.rpc.FileReadCommand(TabRpcClient, {
                    info: { path: filePath },
                });
                const content = base64ToString(fileData?.data64);
                try {
                    return JSON.parse(content);
                } catch {
                    globalStore.set(this.errorMsgAtom, {
                        status: "Invalid Diagram File",
                        text: "The file does not contain valid Excalidraw JSON. The file may be corrupted.",
                    });
                    return null;
                }
            } catch (e) {
                const errStr = `${e}`;
                const isNotFound = errStr.includes("not found") || errStr.includes("no such file");
                globalStore.set(this.errorMsgAtom, {
                    status: isNotFound ? "File Not Found" : "File Read Failed",
                    text: errStr,
                });
                return null;
            }
        });

        this.loadableSceneAtom = loadable(this.sceneAtom);

        this.pushSceneUnsubFn = waveEventSubscribeSingle({
            eventType: "excalidraw:pushscene",
            scope: `block:${blockId}`,
            handler: async (event) => {
                const pushData = event.data as any;
                if (!pushData) return;

                let elements: any[];
                let appState: any = {};
                let files: any = undefined;

                if (pushData.format === "mermaid") {
                    try {
                        const mermaidText = pushData.scenedata as string;
                        const result = await parseMermaidToExcalidraw(mermaidText);
                        elements = convertToExcalidrawElements(result.elements);
                        files = result.files;
                    } catch (e) {
                        globalStore.set(this.errorMsgAtom, {
                            status: "Mermaid Conversion Failed",
                            text: `${e}`,
                        });
                        return;
                    }
                } else {
                    const sceneData = pushData.scenedata ?? pushData;
                    if (sceneData?.type === "excalidraw") {
                        elements = sceneData.elements || [];
                        appState = sceneData.appState || {};
                    } else if (Array.isArray(sceneData)) {
                        elements = sceneData;
                    } else {
                        return;
                    }
                }

                const sceneUpdate = { elements, appState, files };
                if (!this.excalidrawAPI) {
                    this.pendingPushScene = sceneUpdate;
                    return;
                }

                this.excalidrawAPI.updateScene({
                    ...sceneUpdate,
                    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
                });

                this.lastSavedVersion = getSceneVersion(elements);
            },
        });
    }

    setExcalidrawAPI(api: any) {
        this.excalidrawAPI = api;
        if (this.pendingPushScene && api) {
            api.updateScene({
                ...this.pendingPushScene,
                captureUpdate: CaptureUpdateAction.IMMEDIATELY,
            });
            this.lastSavedVersion = getSceneVersion(this.pendingPushScene.elements);
            this.pendingPushScene = null;
        }
    }

    handleChange(elements: readonly any[], appState: any, files: any) {
        const newVersion = getSceneVersion(elements);
        if (newVersion === this.lastSavedVersion) {
            return;
        }
        globalStore.set(this.isDirtyAtom, true);
        this.pendingElements = elements;
        this.pendingAppState = appState;
        this.pendingFiles = files;
        this.debouncedSave();
    }

    private debouncedSave() {
        if (this.saveTimeoutId != null) {
            clearTimeout(this.saveTimeoutId);
        }
        this.saveTimeoutId = setTimeout(() => this.performSave(), AutosaveDebounceMs);
    }

    async performSave() {
        const filePath = globalStore.get(this.filePathAtom);
        if (!filePath) {
            return;
        }
        const sceneData = {
            type: "excalidraw",
            version: 2,
            elements: this.pendingElements,
            appState: {
                viewBackgroundColor: this.pendingAppState?.viewBackgroundColor,
            },
            files: this.pendingFiles,
        };
        try {
            await this.env.rpc.FileWriteCommand(TabRpcClient, {
                info: { path: filePath },
                data64: stringToBase64(JSON.stringify(sceneData, null, 2)),
            });
            this.lastSavedVersion = getSceneVersion(this.pendingElements as any[]);
            globalStore.set(this.isDirtyAtom, false);
        } catch (e) {
            console.error("excalidraw autosave failed:", e);
        }
    }

    dispose() {
        if (this.pushSceneUnsubFn) {
            this.pushSceneUnsubFn();
            this.pushSceneUnsubFn = null;
        }
        if (this.saveTimeoutId != null) {
            clearTimeout(this.saveTimeoutId);
            this.saveTimeoutId = null;
        }
        if (globalStore.get(this.isDirtyAtom)) {
            this.performSave();
        }
    }
}
