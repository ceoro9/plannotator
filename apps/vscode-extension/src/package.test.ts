import { expect, test } from "bun:test";
import manifest from "../package.json";

test("places review finalization actions in the Comments view title", () => {
  const items = manifest.contributes.menus["view/title"];

  expect(items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        command: "plannotator-webview.sendReviewFeedback",
        when: "view == workbench.panel.comments && plannotator.activeReview",
      }),
      expect.objectContaining({
        command: "plannotator-webview.approveReview",
        when: "view == workbench.panel.comments && plannotator.activeReview",
      }),
    ]),
  );
});
