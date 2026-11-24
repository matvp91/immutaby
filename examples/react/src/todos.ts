export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

export interface State {
  todos: Todo[];
  nextId: number;
}

export type Action =
  | { type: "add"; title: string }
  | { type: "toggle"; id: number }
  | { type: "rename"; id: number; title: string }
  | { type: "remove"; id: number }
  | { type: "clearDone" };

export const initialState: State = {
  todos: [{ id: 1, title: "Try immutaby", done: false }],
  nextId: 2,
};

/**
 * Written as mutations; compiled into copy-on-write updates. Untouched todos
 * keep their identity, so memoized rows don't re-render.
 */
export function reducer(state: State, action: Action): State {
  let s = state;
  mut: {
    switch (action.type) {
      case "add":
        s.todos.push({ id: s.nextId, title: action.title, done: false });
        s.nextId++;
        break;
      case "toggle": {
        const todo = s.todos.find((item) => item.id === action.id);
        if (todo) {
          todo.done = !todo.done;
        }
        break;
      }
      case "rename": {
        const todo = s.todos.find((item) => item.id === action.id);
        if (todo) {
          todo.title = action.title;
        }
        break;
      }
      case "remove":
        s.todos = s.todos.filter((item) => item.id !== action.id);
        break;
      case "clearDone":
        s.todos = s.todos.filter((item) => !item.done);
        break;
    }
  }
  return s;
}
