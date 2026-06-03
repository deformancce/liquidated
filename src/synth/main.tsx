import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SynthApp } from "./SynthApp";
import "./synth.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <SynthApp />
  </StrictMode>
);
