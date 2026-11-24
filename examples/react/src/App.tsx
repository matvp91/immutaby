import type { Dispatch, SubmitEvent } from "react";
import { memo, useReducer } from "react";
import type { Action, Todo } from "./todos.ts";
import { initialState, reducer } from "./todos.ts";

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const remaining = state.todos.filter((todo) => !todo.done).length;

  function add(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const title = new FormData(form).get("title")?.toString().trim();
    if (title) {
      dispatch({ type: "add", title });
      form.reset();
    }
  }

  return (
    <main>
      <h1>Todos</h1>
      <form onSubmit={add}>
        <input name="title" placeholder="What needs doing?" />
        <button type="submit">Add</button>
      </form>
      <ul>
        {state.todos.map((todo) => (
          <TodoItem key={todo.id} todo={todo} dispatch={dispatch} />
        ))}
      </ul>
      <p>
        {remaining} left{" "}
        <button type="button" onClick={() => dispatch({ type: "clearDone" })}>
          Clear done
        </button>
      </p>
    </main>
  );
}

interface TodoItemProps {
  todo: Todo;
  dispatch: Dispatch<Action>;
}

// Only re-renders when its own todo changed: the reducer keeps the identity of
// every todo it didn't touch.
const TodoItem = memo(function TodoItem({ todo, dispatch }: TodoItemProps) {
  return (
    <li>
      <input
        type="checkbox"
        checked={todo.done}
        onChange={() => dispatch({ type: "toggle", id: todo.id })}
      />
      <input
        value={todo.title}
        onChange={(event) =>
          dispatch({ type: "rename", id: todo.id, title: event.target.value })
        }
      />
      <button
        type="button"
        onClick={() => dispatch({ type: "remove", id: todo.id })}
      >
        Remove
      </button>
    </li>
  );
});
