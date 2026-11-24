export interface Todo {
  id: number;
  title: string;
  done: boolean;
  tags: string[];
}

export interface State {
  user: { name: string; profile: { email: string; visits: number } };
  settings: { theme: string; locale: string };
  todos: Todo[];
}

export function createState(todos: number): State {
  return {
    user: { name: "Ada", profile: { email: "ada@example.com", visits: 0 } },
    settings: { theme: "dark", locale: "en" },
    todos: Array.from({ length: todos }, (_, i) => ({
      id: i,
      title: `todo ${i}`,
      done: i % 2 === 0,
      tags: ["a"],
    })),
  };
}
