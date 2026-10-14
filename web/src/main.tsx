import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LanguageProvider } from "./i18n";
import { bootTheme, GarageTheme } from "./theme";
import "@radix-ui/themes/styles.css";
import "./index.css";
import "./mobile.css";

bootTheme(document.documentElement, localStorage);

const queryClient = new QueryClient();
const root = document.getElementById("root");
if (!root) {
  throw new Error("root element missing");
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <GarageTheme><App /></GarageTheme>
      </LanguageProvider>
    </QueryClientProvider>
  </StrictMode>,
);
