// Roundel sizes per surface, in one place so the brand scales together instead
// of drifting apart (the sizes were previously hard-coded per call site).
//   header: sits beside the church name in a dense bar.
//   card:   the sign-in card and error screen, no chrome around it, so the
//           roundel runs larger to carry the same visual weight.
export const LOGO_SIZE = { header: 64, card: 128 };
