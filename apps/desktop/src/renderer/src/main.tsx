import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { CapturePickerOverlayApp } from "./CapturePickerOverlayApp";
import "./styles.css";

const searchParams = new URLSearchParams(window.location.search);
const isCapturePickerOverlay = searchParams.get("overlay") === "capture-picker";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isCapturePickerOverlay ? <CapturePickerOverlayApp /> : <App />}
  </React.StrictMode>
);
