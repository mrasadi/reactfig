import { describe, it, expect } from "vitest";
import { verifyCapturedOwner } from "../../src/browser/captureComponent.js";

describe(
  "verifyCapturedOwner — catches a selector resolving to the wrong component's DOM " +
    "(real problem: page.locator(...).first() / document.querySelector both silently accept " +
    "the first match for an ambiguous or mistargeted selector, with no indication the match is wrong)",
  () => {
    it("passes when rootComponentName appears in the captured element's ownership chain", () => {
      expect(verifyCapturedOwner("Avatar", ".avatar", ["SessionCard", "Avatar"])).toBeNull();
    });

    it("passes when rootComponentName is the element's only owner", () => {
      expect(verifyCapturedOwner("Button", "button", ["Button"])).toBeNull();
    });

    it("is opt-in: passes (no check performed) when rootComponentName wasn't supplied at all", () => {
      expect(verifyCapturedOwner(undefined, ".avatar", ["SomeOtherComponent"])).toBeNull();
    });

    it(
      "fails with an actionable message naming both the intended component and the actual ownership chain — " +
        "the real reported scenario: a generic selector like '.avatar' or 'button' matching an unrelated component's instance",
      () => {
        const error = verifyCapturedOwner("Badge", "button", ["SessionCard", "Button"]);
        expect(error).not.toBeNull();
        expect(error).toContain('"button"');
        expect(error).toContain('"Badge"');
        expect(error).toContain("SessionCard > Button");
      }
    );

    it("fails with a clear message (not a crash) when componentPath is null — e.g. the selector matched non-React DOM", () => {
      const error = verifyCapturedOwner("Avatar", ".avatar", null);
      expect(error).not.toBeNull();
      expect(error).toContain("no React component ownership found");
    });

    it("fails when componentPath is an empty array (distinct from null, same outcome)", () => {
      const error = verifyCapturedOwner("Avatar", ".avatar", []);
      expect(error).not.toBeNull();
      expect(error).toContain("no React component ownership found");
    });
  }
);
