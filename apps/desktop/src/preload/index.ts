import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type RecorderApi } from "../shared/ipc";

const recorderApi: RecorderApi = {
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.getAppVersion),
  getEnvironment: () => ipcRenderer.invoke(IPC_CHANNELS.getEnvironment),
  recorder: {
    listSources: () => ipcRenderer.invoke(IPC_CHANNELS.recorderListSources),
    listAudioInputs: async () => {
      let devices = await navigator.mediaDevices.enumerateDevices();
      let audioInputs = devices.filter((device) => device.kind === "audioinput");

      if (audioInputs.some((device) => !device.label)) {
        try {
          const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

          permissionStream.getTracks().forEach((track) => track.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
          audioInputs = devices.filter((device) => device.kind === "audioinput");
        } catch (error) {
          console.warn("Could not unlock audio input labels.", error);
        }
      }

      return audioInputs.map((device) => ({
        deviceId: device.deviceId,
        groupId: device.groupId,
        label: device.label || "Microphone"
      }));
    },
    pickTarget: (request) => ipcRenderer.invoke(IPC_CHANNELS.recorderPickTarget, request),
    start: (request) => ipcRenderer.invoke(IPC_CHANNELS.recorderStart, request),
    markMediaStarted: (request) => ipcRenderer.invoke(IPC_CHANNELS.recorderMarkMediaStarted, request),
    pause: (request) => ipcRenderer.invoke(IPC_CHANNELS.recorderPause, request),
    resume: (request) => ipcRenderer.invoke(IPC_CHANNELS.recorderResume, request),
    appendChunk: (request) => ipcRenderer.invoke(IPC_CHANNELS.recorderAppendChunk, request),
    stop: (request) => ipcRenderer.invoke(IPC_CHANNELS.recorderStop, request)
  },
  capturePicker: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.capturePickerGetState),
    complete: (request) => ipcRenderer.invoke(IPC_CHANNELS.capturePickerComplete, request),
    cancel: (request) => ipcRenderer.invoke(IPC_CHANNELS.capturePickerCancel, request)
  },
  project: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.projectList),
    open: (request) => ipcRenderer.invoke(IPC_CHANNELS.projectOpen, request),
    openFolder: (request) => ipcRenderer.invoke(IPC_CHANNELS.projectOpenFolder, request),
    updateEdit: (request) => ipcRenderer.invoke(IPC_CHANNELS.projectUpdateEdit, request)
  },
  export: {
    start: (request) => ipcRenderer.invoke(IPC_CHANNELS.exportStart, request),
    cancel: (request) => ipcRenderer.invoke(IPC_CHANNELS.exportCancel, request),
    appendChunk: (request) => ipcRenderer.invoke(IPC_CHANNELS.exportAppendChunk, request),
    finish: (request) => ipcRenderer.invoke(IPC_CHANNELS.exportFinish, request),
    pickOutputPath: (request) => ipcRenderer.invoke(IPC_CHANNELS.exportPickOutputPath, request),
    openFile: (request) => ipcRenderer.invoke(IPC_CHANNELS.exportOpenFile, request),
    openFolder: (request) => ipcRenderer.invoke(IPC_CHANNELS.exportOpenFolder, request),
    onProgress: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, job: Parameters<typeof callback>[0]) => {
        callback(job);
      };

      ipcRenderer.on(IPC_CHANNELS.exportProgress, listener);

      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.exportProgress, listener);
      };
    }
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    pickDefaultExportDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.settingsPickDefaultExportDirectory),
    update: (request) => ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, request)
  }
};

contextBridge.exposeInMainWorld("recorderApi", recorderApi);
