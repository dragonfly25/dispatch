/** `~` shortening of Windows paths in CLI output (injected platform). */
import { describe, expect, it } from "vitest";
import { tildify, tildifyText } from "../../src/cli/ui.js";

describe("tildify on Windows", () => {
  const home = "C:\\Users\\Me";
  it("shortens paths under the profile, ignoring case and separators", () => {
    expect(tildify("C:\\Users\\Me\\.dispatch\\bin", home, "win32")).toBe("~\\.dispatch\\bin");
    expect(tildify("c:/users/me/x", home, "win32")).toBe("~\\x");
    expect(tildify("c:\\users\\me\\", home, "win32")).toBe("~");
    expect(tildify("C:\\Users\\Meme\\x", home, "win32")).toBe("C:\\Users\\Meme\\x");
    expect(tildify("D:\\x", undefined, "win32")).toBe("D:\\x");
  });

  it("replaces the profile prefix inside free text", () => {
    const text = "wrote c:\\users\\me\\.claude\\x and C:/Users/Me/y; kept C:\\Users\\Mex\\z";
    expect(tildifyText(text, `${home}\\`, "win32")).toBe(
      "wrote ~\\.claude\\x and ~/y; kept C:\\Users\\Mex\\z",
    );
    expect(tildifyText("C:\\a.b(1)\\x", "C:\\a.b(1)", "win32")).toBe("~\\x");
    expect(tildifyText("x", undefined, "win32")).toBe("x");
    expect(tildifyText("x", "\\", "win32")).toBe("x");
  });
});
