import { KanbanBoardId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import * as Dialog from "../../components/ui/Dialog";
import { renameBoard } from "./boardActions";

const { updateBoard } = vi.hoisted(() => ({ updateBoard: vi.fn() }));
vi.mock("../../components/ui/Dialog", () => ({ prompt: vi.fn(), alert: vi.fn() }));
vi.mock("./kanbanStore", () => ({ kanbanClient: () => ({ updateBoard }) }));

beforeEach(() => {
  vi.clearAllMocks();
  updateBoard.mockResolvedValue(undefined);
});

it("prefills the rename prompt and saves the trimmed name", () => {
  const boardId = KanbanBoardId.make("board-robob");
  renameBoard(boardId, "Robob");
  const prompt = vi.mocked(Dialog.prompt).mock.calls[0]![0];
  expect(prompt.initialValue).toBe("Robob");
  prompt.onConfirm("  Board work  ");
  expect(updateBoard).toHaveBeenCalledExactlyOnceWith({ boardId, name: "Board work" });
});

it.each(["", " \t\n", "Robob", " Robob "])("does not save %j", (value) => {
  renameBoard(KanbanBoardId.make("board-robob"), "Robob");
  vi.mocked(Dialog.prompt).mock.calls[0]![0].onConfirm(value);
  expect(updateBoard).not.toHaveBeenCalled();
});

it("shows a failed rename without retrying it", async () => {
  updateBoard.mockRejectedValue(new Error("Connection closed"));
  renameBoard(KanbanBoardId.make("board-robob"), "Robob");
  vi.mocked(Dialog.prompt).mock.calls[0]![0].onConfirm("Board work");
  await Promise.resolve();
  expect(Dialog.alert).toHaveBeenCalledWith("Could not rename", "Connection closed");
  expect(updateBoard).toHaveBeenCalledTimes(1);
});
