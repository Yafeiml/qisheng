/** The DOM parser and rendered-image fingerprint use the same fixed note scope. */
export const NOTE_ROOTS = ["#note-detail", ".note-detail-container", ".note-container", "article"];
export const NOTE_IMAGE_CHILDREN = [
  ".swiper-wrapper img",
  ".media-container img",
  ".note-slider img",
];

export const NOTE_ROOT_SELECTOR = NOTE_ROOTS.join(", ");
export const NOTE_IMAGE_CHILD_SELECTOR = NOTE_IMAGE_CHILDREN.join(", ");
export const NOTE_IMAGE_SELECTOR = NOTE_ROOTS.flatMap((root) =>
  NOTE_IMAGE_CHILDREN.map((child) => `${root} ${child}`),
).join(", ");
