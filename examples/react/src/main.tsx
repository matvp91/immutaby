import { createRoot } from "react-dom/client";
import { Profile } from "./Profile.tsx";
import { Todos } from "./Todo/index.tsx";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root element");
}

createRoot(root).render(
  <main>
    <Todos />
    <Profile />
  </main>,
);
