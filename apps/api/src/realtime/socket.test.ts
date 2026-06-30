import { describe, it, expect } from "vitest";
import { messageCreatedRooms } from "./socket.js";

describe("messageCreatedRooms", () => {
  it("unions the conversation room with each member's user room", () => {
    expect(messageCreatedRooms("conv1", "proj1", ["a", "b"])).toEqual([
      "conversation:conv1",
      "user:proj1:a",
      "user:proj1:b",
    ]);
  });
  it("returns just the conversation room when there are no members", () => {
    expect(messageCreatedRooms("conv1", "proj1", [])).toEqual(["conversation:conv1"]);
  });
});
