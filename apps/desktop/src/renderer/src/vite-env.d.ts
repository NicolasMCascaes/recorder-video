/// <reference types="vite/client" />

import type { RecorderApi } from "../../shared/ipc";

declare global {
  interface Window {
    recorderApi: RecorderApi;
  }
}
