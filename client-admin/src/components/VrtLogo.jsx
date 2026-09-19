export default function VrtLogo({ size = 40, className = '', withWordmark = false }) {
  // BASE_URL-relative so the asset resolves under the admin app's /admin/ base
  // path (and the pastor app's default '/') in both dev and build.
  const src = `${import.meta.env.BASE_URL}vrt-roundel.png`;
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <img
        src={src}
        alt="Victory Revival Temple"
        className="rounded-2xl"
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: 'contain' }}
      />
      {withWordmark && (
        <span className="font-display text-sm font-semibold tracking-wide text-brand-800">Victory Revival Temple</span>
      )}
    </span>
  );
}
