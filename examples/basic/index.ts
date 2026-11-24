interface Todo {
  id: number;
  title: string;
  done: boolean;
}

interface State {
  user: { name: string };
  todos: Todo[];
}

export function addTodo(state: State, title: string): State {
  let s = state;
  mut: {
    s.todos.push({ id: s.todos.length + 1, title, done: false });
  }
  return s;
}

export function toggle(state: State, index: number): State {
  let s = state;
  mut: {
    s.todos[index].done = !s.todos[index].done;
  }
  return s;
}

const initial: State = { user: { name: "Ada" }, todos: [] };
const one = addTodo(initial, "write the plugin");
const two = toggle(one, 0);

console.log(
  JSON.stringify(two),
  "user shared:",
  two.user === initial.user,
  "base untouched:",
  initial.todos.length === 0,
);
