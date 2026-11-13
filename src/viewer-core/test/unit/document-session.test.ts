import { expect, it } from "vitest";
import { DocumentSession } from "../../src/document-session.js";
import type { EngineDocument, EnginePage } from "../../src/engine.js";
import type { Rotation } from "../../src/geometry.js";
import { normalizeRotation } from "../../src/geometry.js";

/** A page that only knows its own rotation, which is all a session asks a page for. */
function pageRotatedBy(own: Rotation): EnginePage {
  const geometry = (viewRotation: Rotation) =>
    ({ width: 600, height: 800, rotation: normalizeRotation(own + viewRotation) });
  return { geometry } as EnginePage;
}

const session = () => new DocumentSession({ pageCount: 3, pageLabels: null } as EngineDocument);

it("viewRotation_ShouldBeViewingRotation_WhenPageHasNoRotationOfItsOwnSet", () => {
  expect(session().viewRotation(pageRotatedBy(90), 1, 180)).toBe(180);
});

it.each([[0, 270, 270], [90, 270, 180], [270, 90, 180], [180, 180, 0]] as const)(
  "viewRotation_ShouldReachRotationSetForPage_WhenPageIsRotatedBy%iAndSetTo%i", (own, set, expected) => {
    const documentSession = session();
    documentSession.setPageRotation(2, set);

    expect(documentSession.viewRotation(pageRotatedBy(own), 2, 90)).toBe(expected);
  });

it("viewRotation_ShouldLeaveOtherPagesAlone_WhenOnePageHasRotationSet", () => {
  const documentSession = session();
  documentSession.setPageRotation(2, 270);

  expect(documentSession.viewRotation(pageRotatedBy(0), 1, 90)).toBe(90);
});

it("setPageRotation_ShouldReturnPageToViewingRotation_WhenGivenNull", () => {
  const documentSession = session();
  documentSession.setPageRotation(2, 270);

  documentSession.setPageRotation(2, null);

  expect(documentSession.viewRotation(pageRotatedBy(0), 2, 90)).toBe(90);
});
