import { test } from "node:test";
import assert from "node:assert/strict";
import { discordCreatedAt } from "../src/auth.ts";

test("a Discord id gives the account's creation time", () => {
  assert.equal(new Date(discordCreatedAt("143476957122658306")).toISOString(), "2016-01-31T22:06:12.251Z");
  // Discord's own example (https://discord.com/developers/docs/reference#snowflakes).
  assert.equal(new Date(discordCreatedAt("175928847299117063")).toISOString(), "2016-04-30T11:18:25.796Z");
});
