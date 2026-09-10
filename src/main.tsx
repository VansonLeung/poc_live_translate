import React from "react";
import ReactDOM from "react-dom/client";
import { App as AntApp, ConfigProvider } from "antd";
import App from "./App";
import { useReducedMotion } from "./useReducedMotion";
import "antd/dist/reset.css";
import "./styles.css";

function Root() {
  const reducedMotion = useReducedMotion();
  return (
    <ConfigProvider
      theme={{
        token: {
          // Let Ant Design skip motion internally so popup alignment still completes.
          motion: !reducedMotion,
          colorPrimary: "#126b63",
          colorInfo: "#126b63",
          borderRadius: 9,
          fontFamily:
            'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          controlHeight: 42,
        },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
