import { describe, expect, it } from "bun:test";
import { MessageEvent, VALID_MESSAGE_TYPES } from "../src/constants";

describe("constants", () => {
  describe("MessageEvent", () => {
    it("should have lifecycle message types", () => {
      expect(MessageEvent.INIT).toBe("__INIT__");
      expect(MessageEvent.READY).toBe("__READY__");
      expect(MessageEvent.CHILD_HELLO).toBe("__CHILD_HELLO__");
    });

    it("should have property message type", () => {
      expect(MessageEvent.PROPS_UPDATE).toBe("__PROPS_UPDATE__");
    });

    it("should have event message types", () => {
      expect(MessageEvent.EVENT).toBe("__EVENT__");
      expect(MessageEvent.CUSTOM_EVENT).toBe("__CUSTOM_EVENT__");
    });

    it("should have function message types", () => {
      expect(MessageEvent.FUNCTION_CALL).toBe("__FUNCTION_CALL__");
      expect(MessageEvent.FUNCTION_RESPONSE).toBe("__FUNCTION_RESPONSE__");
      expect(MessageEvent.FUNCTION_RELEASE).toBe("__FUNCTION_RELEASE__");
      expect(MessageEvent.FUNCTION_RELEASE_BATCH).toBe("__FUNCTION_RELEASE_BATCH__");
    });

    it("should have exactly 10 message types", () => {
      const keys = Object.keys(MessageEvent);
      expect(keys).toHaveLength(10);
    });

    it("should have all message types prefixed with double underscore", () => {
      const values = Object.values(MessageEvent);
      values.forEach((value) => {
        expect(value).toMatch(/^__[A-Z_]+__$/);
      });
    });
  });

  describe("VALID_MESSAGE_TYPES", () => {
    it("should contain every MessageEvent value", () => {
      const values = Object.values(MessageEvent);
      expect(VALID_MESSAGE_TYPES.size).toBe(values.length);
      for (const value of values) {
        expect(VALID_MESSAGE_TYPES.has(value)).toBe(true);
      }
    });
  });
});
