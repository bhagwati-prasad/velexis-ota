"use client";

// The theme editor of the storefront settings (OAD-014; README §9 "Theme editor", routes.md §9, OADR-0012 point 4,
// ota/frontend/README.md §6): the fields of the `branding` section (the logos and the favicon chosen from the uploaded
// images, the five colours, the two fonts of the bundled list, the corner radius) with a live preview of the colours,
// fonts and radius, and the contrast check of lib/contrast.ts: when a colour pair fails WCAG AA (4.5:1) the hosted
// storefront shows its neutral colours instead, and the editor says so, pair by pair, while staff type. The section's
// form (sections.tsx) posts the fields and shows the API's answer; this component only edits them.
//
// The images are chosen by id from `console.settings.assets.list` of their kind (the page reads them); the admin's CSP
// shows images of its own origin only (`img-src 'self' data:`), so the pickers name each image (file name, dimensions,
// size) instead of showing it, and the Assets page links to it. Every input has `autoComplete="off"`.
import type { StorefrontAsset, StorefrontSettings } from "@velexis/ota-sdk";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";

import { RadioField, SelectField } from "@/app/(console)/bookings/[bookingId]/patch-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fieldError, type ActionState } from "@/lib/action-state";
import {
  BRAND_COLOR_NAMES,
  MIN_TEXT_CONTRAST,
  STOREFRONT_NEUTRAL_PALETTE,
  checkBrandColors,
  contrastRatio,
  describeFailure,
  formatRatio,
  isHexColor,
  storefrontPalette,
  type BrandColorName,
} from "@/lib/contrast";

import { assetKindLabel, assetListHref, assetOptionLabel, type AssetKind } from "../assets/asset-rules";
import { CORNER_RADII, FONT_FAMILIES, RADIUS_VALUES, fontStackOf } from "./settings-rules";

type Branding = StorefrontSettings["branding"];
type CornerRadius = Branding["cornerRadius"];

/** The uploaded images by kind, as the page read them (newest first). */
export type AssetsByKind = Readonly<Partial<Record<AssetKind, readonly StorefrontAsset[]>>>;

export const THEME_STRINGS = Object.freeze({
  logos: "Logos and favicon",
  logosHint:
    "Choose from the images uploaded on the Assets page. The storefront shows them from its own address.",
  noImage: "No image",
  currentOnly: "Only the current choice is listed.",
  notListed: (id: string) => `${id} (not among the images listed)`,
  uploadLink: (kind: string) => `Upload a ${kind.toLowerCase()}`,
  assetsUnavailable:
    "The uploaded images could not be loaded, so only the current choices are listed. Reload the page to choose another one.",
  pickers: {
    logoAssetId: { label: "Logo", kind: "logo", hint: "For light backgrounds." },
    logoDarkAssetId: {
      label: "Logo for dark backgrounds",
      kind: "logo_dark",
      hint: "Shown on a dark header.",
    },
    logoSquareAssetId: { label: "Square logo", kind: "logo_square", hint: "For e-mails and icons." },
    faviconAssetId: { label: "Favicon", kind: "favicon", hint: "The icon of the browser tab." },
  } satisfies Record<string, { readonly label: string; readonly kind: AssetKind; readonly hint: string }>,
  colors: "Colours",
  colorsHint: "Each as #RRGGBB. The storefront computes the text on buttons, the header and the footer.",
  colorNames: {
    primary: { label: "Primary", hint: "Buttons and links." },
    secondary: { label: "Secondary", hint: "Header and footer." },
    accent: { label: "Accent", hint: "Badges and highlights." },
    background: { label: "Background", hint: "The page." },
    text: { label: "Text", hint: "Body text." },
  } satisfies Record<BrandColorName, { readonly label: string; readonly hint: string }>,
  picker: (label: string) => `${label}: colour picker`,
  fonts: "Fonts",
  fontsHint: "From the fonts bundled with the storefront.",
  headingFont: "Headings",
  bodyFont: "Body text",
  cornerRadius: "Corner radius of buttons and cards",
  preview: "Preview",
  previewHint:
    "Your colours and corner radius as the storefront shows them when every pair passes the check below; the fonts show as chosen when this computer has them.",
  previewHeader: "Your brand",
  previewHeading: "Flights to Oslo",
  previewText: "Prices include taxes and fees.",
  previewLink: "Baggage rules",
  previewAccent: "Best price",
  previewButton: "Search flights",
  ratios: "Contrast",
  ratioLines: {
    text: "Text on the background",
    primary: "Links on the background",
    accent: "Accent on the background",
    onPrimary: "Button text on primary",
    onSecondary: "Header text on secondary",
  },
  passes: `Every colour pair reaches the WCAG AA contrast of ${MIN_TEXT_CONTRAST}:1: the storefront uses these colours.`,
  failsTitle: "The storefront will not use these colours",
  fails: `Some pairs do not reach the WCAG AA contrast of ${MIN_TEXT_CONTRAST}:1, so the storefront shows its neutral colours instead until you change them:`,
  invalid: (names: string) =>
    `Enter every colour as #RRGGBB (${names}); the storefront shows its neutral colours meanwhile.`,
});

const MUTED = "text-xs text-muted-foreground";
const LINK_CLASS = "text-xs font-medium text-primary underline underline-offset-4";

/** A field's error, linked to its control. */
function FieldMessage({ id, message }: { readonly id: string; readonly message: string | undefined }) {
  return message === undefined ? null : (
    <p id={id} className="text-sm font-medium text-destructive">
      {message}
    </p>
  );
}

/** A group of fields under a heading of the section. */
function Group({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <fieldset className="grid min-w-0 gap-4" aria-describedby={hint === undefined ? undefined : `${id}-hint`}>
      <legend className="mb-1 text-sm font-semibold">{title}</legend>
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className={MUTED}>
          {hint}
        </p>
      )}
      {children}
    </fieldset>
  );
}

/**
 * An image picker: the uploaded images of one kind by name, dimensions and size, "No image", and the current choice
 * even when it is not among the images listed (so saving the section keeps it).
 */
export function AssetPicker({
  name,
  label,
  hint,
  kind,
  current,
  assets,
  unavailable,
  state,
}: {
  /** The form field (`branding.logoAssetId`, `seo.ogImageAssetId`). */
  readonly name: string;
  readonly label: string;
  readonly hint: string;
  readonly kind: AssetKind;
  /** The saved asset id, or `null`. */
  readonly current: string | null;
  readonly assets: AssetsByKind;
  readonly unavailable: boolean;
  readonly state: ActionState;
}) {
  const listed = assets[kind] ?? [];
  const choices = [
    ...(current !== null && !listed.some((asset) => asset.id === current)
      ? [{ value: current, label: THEME_STRINGS.notListed(current) }]
      : []),
    ...listed.map((asset) => ({ value: asset.id, label: assetOptionLabel(asset) })),
  ];
  return (
    <div className="grid gap-1">
      <SelectField
        name={name}
        label={label}
        hint={unavailable ? `${hint} ${THEME_STRINGS.currentOnly}` : hint}
        state={state}
        choices={choices}
        defaultValue={current ?? ""}
        placeholder={THEME_STRINGS.noImage}
      />
      <Link href={assetListHref(kind)} className={LINK_CLASS}>
        {THEME_STRINGS.uploadLink(assetKindLabel(kind))}
      </Link>
    </div>
  );
}

/** A colour: the `#RRGGBB` text the form posts and a native colour picker beside it, both editing the same value. */
function ColorField({
  name,
  value,
  onChange,
  state,
}: {
  readonly name: BrandColorName;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly state: ActionState;
}) {
  const id = useId();
  const field = `branding.colors.${name}`;
  const error = fieldError(state, field);
  const words = THEME_STRINGS.colorNames[name];
  const describedBy = [`${id}-hint`, error === undefined ? undefined : `${id}-error`]
    .filter((part) => part !== undefined)
    .join(" ");
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{words.label}</Label>
      <p id={`${id}-hint`} className={MUTED}>
        {words.hint}
      </p>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={THEME_STRINGS.picker(words.label)}
          // The picker needs a valid colour: while the text is not one, it shows black.
          value={isHexColor(value) ? value.toLowerCase() : "#000000"}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-1"
        />
        <Input
          id={id}
          name={field}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          maxLength={7}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          aria-describedby={describedBy}
          {...(error === undefined ? {} : { "aria-invalid": true })}
        />
      </div>
      <FieldMessage id={`${id}-error`} message={error} />
    </div>
  );
}

/** A font select whose choice the preview follows. */
function FontField({
  name,
  label,
  value,
  onChange,
  state,
}: {
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly state: ActionState;
}) {
  const id = useId();
  const error = fieldError(state, name);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        name={name}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        autoComplete="off"
        className="flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
        {...(error === undefined ? {} : { "aria-invalid": true, "aria-describedby": `${id}-error` })}
      >
        {FONT_FAMILIES.includes(value as (typeof FONT_FAMILIES)[number]) ? null : (
          <option value={value}>{value}</option>
        )}
        {FONT_FAMILIES.map((family) => (
          <option key={family} value={family}>
            {family}
          </option>
        ))}
      </select>
      <FieldMessage id={`${id}-error`} message={error} />
    </div>
  );
}

/** The colours a preview can paint with: each chosen one when valid, else the storefront's neutral value. */
function previewColors(colors: Readonly<Record<BrandColorName, string>>) {
  const valid = Object.fromEntries(
    BRAND_COLOR_NAMES.map((name) => [
      name,
      isHexColor(colors[name]) ? colors[name] : STOREFRONT_NEUTRAL_PALETTE[name],
    ]),
  ) as Record<BrandColorName, string>;
  return storefrontPalette(valid);
}

/** The preview of the theme and the contrast check, updated as staff type. */
function ThemePreview({
  colors,
  headingFont,
  bodyFont,
  cornerRadius,
}: {
  readonly colors: Readonly<Record<BrandColorName, string>>;
  readonly headingFont: string;
  readonly bodyFont: string;
  readonly cornerRadius: CornerRadius;
}) {
  const id = useId();
  const check = checkBrandColors(colors);
  const palette = previewColors(colors);
  const radius = RADIUS_VALUES[cornerRadius] ?? RADIUS_VALUES.medium;
  const ratios: readonly (readonly [string, number])[] = [
    [THEME_STRINGS.ratioLines.text, contrastRatio(palette.text, palette.background)],
    [THEME_STRINGS.ratioLines.primary, contrastRatio(palette.primary, palette.background)],
    [THEME_STRINGS.ratioLines.accent, contrastRatio(palette.accent, palette.background)],
    [THEME_STRINGS.ratioLines.onPrimary, contrastRatio(palette.onPrimary, palette.primary)],
    [THEME_STRINGS.ratioLines.onSecondary, contrastRatio(palette.onSecondary, palette.secondary)],
  ];
  return (
    <section aria-labelledby={id} className="grid min-w-0 gap-3 rounded-md border p-4">
      <div className="grid gap-1">
        <h3 id={id} className="text-sm font-semibold">
          {THEME_STRINGS.preview}
        </h3>
        <p className={MUTED}>{THEME_STRINGS.previewHint}</p>
      </div>
      {/* A picture of the storefront in the chosen colours: the words below say what it shows. */}
      <div
        aria-hidden="true"
        data-preview="theme"
        className="grid gap-3 overflow-hidden border"
        style={{
          backgroundColor: palette.background,
          color: palette.text,
          fontFamily: fontStackOf(bodyFont),
          borderRadius: radius,
        }}
      >
        <div
          className="px-4 py-2 text-sm font-semibold"
          style={{ backgroundColor: palette.secondary, color: palette.onSecondary }}
        >
          {THEME_STRINGS.previewHeader}
        </div>
        <div className="grid gap-2 px-4 pb-4">
          <p className="text-lg font-semibold" style={{ fontFamily: fontStackOf(headingFont) }}>
            {THEME_STRINGS.previewHeading}
          </p>
          <p className="text-sm">
            {THEME_STRINGS.previewText}{" "}
            <span className="underline" style={{ color: palette.primary }}>
              {THEME_STRINGS.previewLink}
            </span>
          </p>
          <p className="text-sm font-semibold" style={{ color: palette.accent }}>
            {THEME_STRINGS.previewAccent}
          </p>
          <span
            className="w-fit px-4 py-2 text-sm font-semibold"
            style={{ backgroundColor: palette.primary, color: palette.onPrimary, borderRadius: radius }}
          >
            {THEME_STRINGS.previewButton}
          </span>
        </div>
      </div>
      <div className="grid gap-1">
        <p className="text-sm font-medium">{THEME_STRINGS.ratios}</p>
        <ul className="grid gap-0.5 text-sm">
          {ratios.map(([label, ratio]) => (
            <li key={label} data-ratio={ratio >= MIN_TEXT_CONTRAST ? "passes" : "fails"}>
              {label}: <span className="tabular-nums">{formatRatio(ratio)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div role="status" aria-live="polite" data-contrast={check.fallsBack ? "fails" : "passes"}>
        {check.invalid.length > 0 ? (
          <p className="rounded-md border border-amber-500 bg-amber-100 px-3 py-2 text-sm text-amber-950">
            {THEME_STRINGS.invalid(
              check.invalid.map((name) => THEME_STRINGS.colorNames[name].label.toLowerCase()).join(", "),
            )}
          </p>
        ) : check.failures.length > 0 ? (
          <div className="grid gap-1 rounded-md border border-amber-500 bg-amber-100 px-3 py-2 text-sm text-amber-950">
            <p className="font-semibold">{THEME_STRINGS.failsTitle}</p>
            <p>{THEME_STRINGS.fails}</p>
            <ul className="grid list-disc gap-0.5 pl-5">
              {check.failures.map((failure) => (
                <li key={`${failure.foreground}-${failure.background}`}>{describeFailure(failure)}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm">{THEME_STRINGS.passes}</p>
        )}
      </div>
    </section>
  );
}

export interface ThemeEditorProps {
  /** The `branding` section as the API answered it. */
  readonly branding: Branding;
  /** The uploaded images of the picker kinds. */
  readonly assets: AssetsByKind;
  /** The images could not be read: the pickers list the current choices only. */
  readonly assetsUnavailable: boolean;
  /** The section form's state: the fields show their errors. */
  readonly state: ActionState;
}

/** The fields of the `branding` section with the live preview and the contrast check. */
export function ThemeEditor({ branding, assets, assetsUnavailable, state }: ThemeEditorProps) {
  const [colors, setColors] = useState<Record<BrandColorName, string>>({ ...branding.colors });
  const [headingFont, setHeadingFont] = useState<string>(branding.fonts.heading);
  const [bodyFont, setBodyFont] = useState<string>(branding.fonts.body);
  const [cornerRadius, setCornerRadius] = useState<CornerRadius>(branding.cornerRadius);
  const pickers = Object.entries(THEME_STRINGS.pickers) as [
    keyof typeof THEME_STRINGS.pickers,
    (typeof THEME_STRINGS.pickers)[keyof typeof THEME_STRINGS.pickers],
  ][];

  return (
    <div className="grid gap-6">
      <Group title={THEME_STRINGS.logos} hint={THEME_STRINGS.logosHint}>
        {assetsUnavailable ? (
          <p role="note" className="text-sm text-muted-foreground">
            {THEME_STRINGS.assetsUnavailable}
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {pickers.map(([field, picker]) => (
            <AssetPicker
              key={field}
              name={`branding.${field}`}
              label={picker.label}
              hint={picker.hint}
              kind={picker.kind}
              current={branding[field]}
              assets={assets}
              unavailable={assetsUnavailable}
              state={state}
            />
          ))}
        </div>
      </Group>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-6">
          <Group title={THEME_STRINGS.colors} hint={THEME_STRINGS.colorsHint}>
            <div className="grid gap-4 sm:grid-cols-2">
              {BRAND_COLOR_NAMES.map((name) => (
                <ColorField
                  key={name}
                  name={name}
                  value={colors[name]}
                  onChange={(value) => setColors((previous) => ({ ...previous, [name]: value.trim() }))}
                  state={state}
                />
              ))}
            </div>
          </Group>
          <Group title={THEME_STRINGS.fonts} hint={THEME_STRINGS.fontsHint}>
            <div className="grid gap-4 sm:grid-cols-2">
              <FontField
                name="branding.fonts.heading"
                label={THEME_STRINGS.headingFont}
                value={headingFont}
                onChange={setHeadingFont}
                state={state}
              />
              <FontField
                name="branding.fonts.body"
                label={THEME_STRINGS.bodyFont}
                value={bodyFont}
                onChange={setBodyFont}
                state={state}
              />
            </div>
          </Group>
          <RadioField
            name="branding.cornerRadius"
            label={THEME_STRINGS.cornerRadius}
            state={state}
            choices={CORNER_RADII}
            value={cornerRadius}
            onChange={(value) => setCornerRadius(value as CornerRadius)}
          />
        </div>
        <div className="grid content-start">
          <ThemePreview
            colors={colors}
            headingFont={headingFont}
            bodyFont={bodyFont}
            cornerRadius={cornerRadius}
          />
        </div>
      </div>
    </div>
  );
}
