/*
Copyright 2022-2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { app, autoUpdater, desktopCapturer, ipcMain, powerSaveBlocker, TouchBar, nativeImage } from "electron";

import IpcMainEvent = Electron.IpcMainEvent;
import { randomArray } from "./utils.js";
import { getDisplayMediaCallback, setDisplayMediaCallback } from "./displayMediaCallback.js";
import Store, { clearDataAndRelaunch } from "./store.js";

const DEFAULT_MATRIX_TTS_BASE_URL = "https://tts.frangent.org";
const MATRIX_TTS_WARMUP_TIMEOUT_MS = Number.parseInt(process.env.ELEMENT_MATRIX_TTS_WARMUP_TIMEOUT_MS ?? "5000", 10);
const MATRIX_TTS_SYNTH_TIMEOUT_MS = Number.parseInt(process.env.ELEMENT_MATRIX_TTS_SYNTH_TIMEOUT_MS ?? "30000", 10);

interface MatrixTtsSynthesizeArgs {
    text: string;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

function getMatrixTtsBaseUrl(): string {
    const configuredValue = Store.instance?.get("matrixTtsBaseUrl");
    if (typeof configuredValue !== "string") {
        return DEFAULT_MATRIX_TTS_BASE_URL;
    }

    const trimmedValue = configuredValue.trim();
    if (!trimmedValue) {
        return DEFAULT_MATRIX_TTS_BASE_URL;
    }

    return trimmedValue;
}

let focusHandlerAttached = false;
ipcMain.on("loudNotification", function (): void {
    if (process.platform === "win32" || process.platform === "linux") {
        if (global.mainWindow && !global.mainWindow.isFocused() && !focusHandlerAttached) {
            global.mainWindow.flashFrame(true);
            global.mainWindow.once("focus", () => {
                global.mainWindow?.flashFrame(false);
                focusHandlerAttached = false;
            });
            focusHandlerAttached = true;
        }
    }
});

let powerSaveBlockerId: number | null = null;
ipcMain.on("app_onAction", function (_ev: IpcMainEvent, payload) {
    switch (payload.action) {
        case "call_state": {
            if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
                if (payload.state === "ended") {
                    powerSaveBlocker.stop(powerSaveBlockerId);
                    powerSaveBlockerId = null;
                }
            } else {
                if (powerSaveBlockerId === null && payload.state === "connected") {
                    powerSaveBlockerId = powerSaveBlocker.start("prevent-display-sleep");
                }
            }
            break;
        }
    }
});

ipcMain.on("ipcCall", async function (_ev: IpcMainEvent, payload) {
    const store = Store.instance;
    if (!global.mainWindow || !store) return;

    const args = payload.args || [];
    let ret: any;

    switch (payload.name) {
        case "getUpdateFeedUrl":
            ret = autoUpdater.getFeedURL();
            break;
        case "setLanguage":
            global.appLocalization.setAppLocale(args[0]);
            break;
        case "getAppVersion":
            ret = app.getVersion();
            break;
        case "focusWindow":
            if (global.mainWindow.isMinimized()) {
                global.mainWindow.restore();
            } else {
                global.mainWindow.show();
                global.mainWindow.focus();
            }
            break;

        case "navigateBack":
            if (global.mainWindow.webContents.canGoBack()) {
                global.mainWindow.webContents.goBack();
            }
            break;
        case "navigateForward":
            if (global.mainWindow.webContents.canGoForward()) {
                global.mainWindow.webContents.goForward();
            }
            break;
        case "setSpellCheckEnabled":
            if (typeof args[0] !== "boolean") return;

            global.mainWindow.webContents.session.setSpellCheckerEnabled(args[0]);
            store.set("spellCheckerEnabled", args[0]);
            break;

        case "getSpellCheckEnabled":
            ret = store.get("spellCheckerEnabled");
            break;

        case "setSpellCheckLanguages":
            try {
                global.mainWindow.webContents.session.setSpellCheckerLanguages(args[0]);
            } catch (er) {
                console.log("There were problems setting the spellcheck languages", er);
            }
            break;

        case "getSpellCheckLanguages":
            ret = global.mainWindow.webContents.session.getSpellCheckerLanguages();
            break;
        case "getAvailableSpellCheckLanguages":
            ret = global.mainWindow.webContents.session.availableSpellCheckerLanguages;
            break;

        case "getPickleKey":
            try {
                ret = await store.getSecret(`${args[0]}|${args[1]}`);
            } catch {
                // if an error is thrown (e.g. we can't initialise safeStorage),
                // then return null, which means the default pickle key will be used
                ret = null;
            }
            break;

        case "createPickleKey":
            try {
                const pickleKey = await randomArray(32);
                await store.setSecret(`${args[0]}|${args[1]}`, pickleKey);
                ret = pickleKey;
            } catch (e) {
                console.error("Failed to create pickle key", e);
                ret = null;
            }
            break;

        case "destroyPickleKey":
            try {
                await store.deleteSecret(`${args[0]}|${args[1]}`);
            } catch (e) {
                console.error("Failed to destroy pickle key", e);
            }
            break;
        case "getDesktopCapturerSources":
            ret = (await desktopCapturer.getSources(args[0])).map((source) => ({
                id: source.id,
                name: source.name,
                thumbnailURL: source.thumbnail.toDataURL(),
            }));
            break;
        case "callDisplayMediaCallback":
            await getDisplayMediaCallback()?.({ video: args[0] });
            setDisplayMediaCallback(null);
            ret = null;
            break;

        case "clearStorage":
            await clearDataAndRelaunch(global.mainWindow.webContents.session);
            return; // the app is about to stop, we don't need to reply to the IPC

        case "breadcrumbs": {
            if (process.platform === "darwin") {
                const { TouchBarPopover, TouchBarButton } = TouchBar;

                const recentsBar = new TouchBar({
                    items: args[0].map((r: { roomId: string; avatarUrl: string | null; initial: string }) => {
                        const defaultColors = ["#0DBD8B", "#368bd6", "#ac3ba8"];
                        let total = 0;
                        for (let i = 0; i < r.roomId.length; ++i) {
                            total += r.roomId.charCodeAt(i);
                        }

                        const button = new TouchBarButton({
                            label: r.initial,
                            backgroundColor: defaultColors[total % defaultColors.length],
                            click: (): void => {
                                void global.mainWindow?.loadURL(`vector://vector/webapp/#/room/${r.roomId}`);
                            },
                        });
                        if (r.avatarUrl) {
                            void fetch(r.avatarUrl)
                                .then((resp) => {
                                    if (!resp.ok) return;
                                    return resp.arrayBuffer();
                                })
                                .then((arrayBuffer) => {
                                    if (!arrayBuffer) return;
                                    const buffer = Buffer.from(arrayBuffer);
                                    button.icon = nativeImage.createFromBuffer(buffer);
                                    button.label = "";
                                    button.backgroundColor = "";
                                });
                        }
                        return button;
                    }),
                });

                const touchBar = new TouchBar({
                    items: [
                        new TouchBarPopover({
                            label: "Recents",
                            showCloseButton: true,
                            items: recentsBar,
                        }),
                    ],
                });
                global.mainWindow.setTouchBar(touchBar);
            }
            break;
        }

        case "matrixTtsWarmup": {
            const matrixTtsBaseUrl = getMatrixTtsBaseUrl();
            const response = await fetchWithTimeout(
                `${matrixTtsBaseUrl}/model/load`,
                {
                    method: "POST",
                },
                MATRIX_TTS_WARMUP_TIMEOUT_MS,
            );
            if (!response.ok) {
                throw new Error(`matrixTtsWarmup failed: HTTP ${response.status}`);
            }
            ret = { ok: true };
            break;
        }

        case "matrixTtsSynthesize": {
            const matrixTtsBaseUrl = getMatrixTtsBaseUrl();
            const request = args[0] as MatrixTtsSynthesizeArgs | undefined;
            if (!request?.text || typeof request.text !== "string") {
                throw new Error("matrixTtsSynthesize requires a non-empty text string");
            }

            const response = await fetchWithTimeout(
                `${matrixTtsBaseUrl}/synthesize`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ text: request.text }),
                },
                MATRIX_TTS_SYNTH_TIMEOUT_MS,
            );

            if (!response.ok) {
                throw new Error(`matrixTtsSynthesize failed: HTTP ${response.status}`);
            }

            const audioBytes = Buffer.from(await response.arrayBuffer());
            ret = {
                audioBase64: audioBytes.toString("base64"),
                mediaType: response.headers.get("content-type") ?? "audio/wav",
            };
            break;
        }

        default:
            global.mainWindow.webContents.send("ipcReply", {
                id: payload.id,
                error: "Unknown IPC Call: " + payload.name,
            });
            return;
    }

    global.mainWindow?.webContents.send("ipcReply", {
        id: payload.id,
        reply: ret,
    });
});

ipcMain.handle("getConfig", () => global.vectorConfig);

const initialisePromiseWithResolvers = Promise.withResolvers<void>();
export const initialisePromise = initialisePromiseWithResolvers.promise;

ipcMain.once("initialise", () => {
    initialisePromiseWithResolvers.resolve();
});
