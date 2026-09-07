export const TASK_FOCUS_KEYS = {
  primary: "task-primary",
  chooseCategory: "task-choose-category",
} as const;

export type TaskFocusKey = (typeof TASK_FOCUS_KEYS)[keyof typeof TASK_FOCUS_KEYS];

export type TextSelectionDirection = "forward" | "backward" | "none" | null;
