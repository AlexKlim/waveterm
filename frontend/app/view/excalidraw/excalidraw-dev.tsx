// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import "@excalidraw/excalidraw/index.css";

import { Excalidraw } from "@excalidraw/excalidraw";

window.EXCALIDRAW_ASSET_PATH = "/excalidraw/";

function ExcalidrawDev() {
    return (
        <div style={{ height: "100%", width: "100%" }}>
            <Excalidraw />
        </div>
    );
}

export { ExcalidrawDev };
