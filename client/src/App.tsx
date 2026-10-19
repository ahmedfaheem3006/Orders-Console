import { useEffect, useState } from "react";

type ApiStatus = "checking" | "ok" | "unreachable";

export function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal })
      .then((res) => setApiStatus(res.ok ? "ok" : "unreachable"))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setApiStatus("unreachable");
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="page">
      <h1>Orders Console</h1>
      <p>
        API status: <strong>{apiStatus}</strong>
      </p>
    </main>
  );
}
