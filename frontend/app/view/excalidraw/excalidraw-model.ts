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
    private lastSavedBackground: string = undefined;
    private lastAppliedPushId: string = null;
    private pushSeq: number = 0;
    private changeSeq: number = 0;
    private pendingElements: readonly any[] = [];
    private pendingAppState: any = null;
    private pendingFiles: any = null;
    private pushSceneUnsubFn: (() => void) | null = null;
    private saveTimeoutId: ReturnType<typeof setTimeout> | null = null;
    private saveChain: Promise<void> = Promise.resolve();
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
            const name = filePath ? (filePath.split("/").pop() ?? "Excalidraw") : "Excalidraw";
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
            handler: (event) => this.handlePushSceneEvent(event),
        });

        // pushscene events are persisted, so a push that fired before this
        // block's frontend subscribed (wsh creates the block and pushes right
        // away, or pushes to a block on an inactive tab) can be replayed
        this.replayPersistedPush().catch((e) => console.error("excalidraw pushscene history read failed:", e));
    }

    private async replayPersistedPush() {
        const events = await this.env.rpc.EventReadHistoryCommand(TabRpcClient, {
            event: "excalidraw:pushscene",
            scope: `block:${this.blockId}`,
            maxitems: 1,
        });
        if (!events || events.length === 0) {
            return;
        }
        const event = events[events.length - 1];
        const pushId = (event.data as any)?.pushid;
        const filePath = globalStore.get(this.filePathAtom);
        if (filePath && pushId) {
            try {
                const fileData = await this.env.rpc.FileReadCommand(TabRpcClient, {
                    info: { path: filePath },
                });
                const scene = JSON.parse(base64ToString(fileData?.data64));
                if (scene?.wavepushid === pushId) {
                    return;
                }
            } catch {
                // unreadable or missing file: the push is the best content we have
            }
        }
        this.handlePushSceneEvent(event);
    }

    private async handlePushSceneEvent(event: WaveEvent) {
        const pushData = event.data as any;
        if (!pushData) return;
        const seq = ++this.pushSeq;

        let elements: any[];
        let appState: any = {};
        let files: any = undefined;

        if (pushData.format === "mermaid") {
            try {
                const mermaidText = pushData.scenedata as string;
                const result = await parseMermaidToExcalidraw(mermaidText);
                if (seq !== this.pushSeq) {
                    return;
                }
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
                files = sceneData.files;
            } else if (Array.isArray(sceneData)) {
                elements = sceneData;
            } else {
                return;
            }
        }

        this.lastAppliedPushId = pushData.pushid ?? null;
        const sceneUpdate = { elements, appState, files };
        if (!this.excalidrawAPI) {
            this.pendingPushScene = sceneUpdate;
            return;
        }
        this.applyRemoteScene(sceneUpdate);
    }

    setExcalidrawAPI(api: any) {
        this.excalidrawAPI = api;
        if (this.pendingPushScene && api) {
            this.applyRemoteScene(this.pendingPushScene);
            this.pendingPushScene = null;
        }
    }

    // updateScene() does not accept binary file data, so image files must go
    // through addFiles() separately or fileId references render as skeletons
    private applyRemoteScene(scene: { elements: any[]; appState?: any; files?: any }) {
        if (scene.files != null && Object.keys(scene.files).length > 0) {
            this.excalidrawAPI.addFiles(Object.values(scene.files));
        }
        this.excalidrawAPI.updateScene({
            elements: scene.elements,
            appState: scene.appState,
            captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        this.pendingElements = scene.elements;
        this.pendingAppState = scene.appState;
        this.pendingFiles = scene.files;
        this.changeSeq++;
        globalStore.set(this.isDirtyAtom, true);
        this.debouncedSave();
    }

    handleChange(elements: readonly any[], appState: any, files: any) {
        // getSceneVersion only tracks elements, so background-only changes
        // need their own comparison or they never reach a save
        const newVersion = getSceneVersion(elements);
        if (newVersion === this.lastSavedVersion && appState?.viewBackgroundColor === this.lastSavedBackground) {
            return;
        }
        globalStore.set(this.isDirtyAtom, true);
        this.pendingElements = elements;
        this.pendingAppState = appState;
        this.pendingFiles = files;
        this.changeSeq++;
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
        // snapshot the scene as JSON now: excalidraw mutates elements in place,
        // and writes are chained so an older queued write cannot clobber a newer one
        const version = getSceneVersion(this.pendingElements as any[]);
        const background = this.pendingAppState?.viewBackgroundColor;
        const seq = this.changeSeq;
        const sceneJson = JSON.stringify(
            {
                type: "excalidraw",
                version: 2,
                elements: this.pendingElements,
                appState: {
                    viewBackgroundColor: this.pendingAppState?.viewBackgroundColor,
                },
                files: this.pendingFiles,
                ...(this.lastAppliedPushId ? { wavepushid: this.lastAppliedPushId } : {}),
            },
            null,
            2
        );
        this.saveChain = this.saveChain.then(async () => {
            try {
                await this.env.rpc.FileWriteCommand(TabRpcClient, {
                    info: { path: filePath },
                    data64: stringToBase64(sceneJson),
                });
                this.lastSavedVersion = version;
                this.lastSavedBackground = background;
                if (this.changeSeq === seq) {
                    globalStore.set(this.isDirtyAtom, false);
                }
            } catch (e) {
                console.error("excalidraw autosave failed:", e);
            }
        });
        return this.saveChain;
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
