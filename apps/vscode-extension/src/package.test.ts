import { expect, test } from "bun:test";
import manifest from "../package.json";

test("places Send Review Feedback in the Comments view title", () => {
  expect(manifest.contributes.menus["view/title"]).toContainEqual({
    command: "plannotator-webview.sendReviewFeedback",
    group: "navigation@1",
    when: "view == workbench.panel.comments && plannotator.activeReview",
  });
});
