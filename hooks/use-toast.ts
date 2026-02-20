"use client";

import * as React from "react";

const TOAST_LIMIT = 5;
const TOAST_REMOVE_DELAY = 3500;

type Toast = {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
};

type ToastState = {
  toasts: Toast[];
};

type ActionType =
  | { type: "ADD_TOAST"; toast: Toast }
  | { type: "REMOVE_TOAST"; toastId?: string };

const listeners: Array<(state: ToastState) => void> = [];
let memoryState: ToastState = { toasts: [] };

function dispatch(action: ActionType) {
  switch (action.type) {
    case "ADD_TOAST":
      memoryState = {
        ...memoryState,
        toasts: [action.toast, ...memoryState.toasts].slice(0, TOAST_LIMIT)
      };
      break;
    case "REMOVE_TOAST":
      memoryState = {
        ...memoryState,
        toasts: action.toastId
          ? memoryState.toasts.filter((t) => t.id !== action.toastId)
          : []
      };
      break;
  }

  listeners.forEach((listener) => {
    listener(memoryState);
  });
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function toast({ ...props }: Omit<Toast, "id">) {
  const id = genId();
  dispatch({
    type: "ADD_TOAST",
    toast: {
      id,
      ...props
    }
  });

  setTimeout(() => {
    dispatch({ type: "REMOVE_TOAST", toastId: id });
  }, TOAST_REMOVE_DELAY);

  return {
    id,
    dismiss: () => dispatch({ type: "REMOVE_TOAST", toastId: id })
  };
}

function useToast() {
  const [state, setState] = React.useState<ToastState>(memoryState);

  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    };
  }, []);

  return {
    ...state,
    toast,
    dismiss: (toastId?: string) => dispatch({ type: "REMOVE_TOAST", toastId })
  };
}

export { useToast, toast };
