-- The full-register Excel embeds a 320 px preview instead of the original file:
-- 11 701 originals produce an ~870 MB workbook, while previews keep it usable.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS thumbnail_key text;
