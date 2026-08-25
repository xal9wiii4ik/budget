import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath as realpathAsync } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  isInside,
  isJpeg,
  readUploadConfig,
  resolveUploadPath,
} from './uploadReceipt.js';

const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

async function fixture(): Promise<{ dir: string; outside: string }> {
  const root = await realpathAsync(await mkdtemp(join(tmpdir(), 'budget-upload-')));
  const dir = join(root, 'allowed');
  const outside = join(root, 'elsewhere');
  await mkdir(dir);
  await mkdir(outside);
  return { dir, outside };
}

describe('isJpeg', () => {
  it('reads the content, not the name', () => {
    expect(isJpeg(JPEG_HEAD)).toBe(true);
    // A PNG renamed to .jpg is the whole reason this check exists.
    expect(isJpeg(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isJpeg(Buffer.from('#!/bin/sh\n'))).toBe(false);
    expect(isJpeg(Buffer.from([0xff, 0xd8]))).toBe(false);
  });
});

describe('isInside', () => {
  it('does not accept a sibling whose name merely starts the same', () => {
    // The bug this pins: startsWith('/a/uploads') also matches '/a/uploads-evil'.
    expect(isInside('/a/uploads', '/a/uploads-evil/x.jpg')).toBe(false);
    expect(isInside('/a/uploads', '/a/uploads/x.jpg')).toBe(true);
    expect(isInside('/a/uploads', '/a/uploads')).toBe(true);
  });
});

describe('readUploadConfig', () => {
  it('is off when unset, so the default posture is no filesystem access', async () => {
    expect(await readUploadConfig({})).toEqual({ dir: null });
    expect(await readUploadConfig({ BUDGET_UPLOAD_DIR: '   ' })).toEqual({ dir: null });
  });

  it('refuses a relative directory', async () => {
    await expect(readUploadConfig({ BUDGET_UPLOAD_DIR: 'uploads' })).rejects.toThrow(
      /absolute path/,
    );
  });
});

describe('resolveUploadPath', () => {
  it('accepts a file in the folder and rejects one above it', async () => {
    const { dir, outside } = await fixture();
    await writeFile(join(dir, 'receipt.jpg'), JPEG_HEAD);
    await writeFile(join(outside, 'secret.jpg'), JPEG_HEAD);

    const inside = await resolveUploadPath(dir, 'receipt.jpg');
    expect(inside.ok).toBe(true);

    // `..` is collapsed before the comparison, so climbing out is caught.
    const climbed = await resolveUploadPath(dir, '../elsewhere/secret.jpg');
    expect(climbed).toMatchObject({ ok: false });
    expect(climbed.ok === false && climbed.message).toMatch(/outside the allowed upload folder/);
  });

  it('follows a symlink before judging it, so a link out is refused', async () => {
    const { dir, outside } = await fixture();
    const secret = join(outside, 'id_rsa.jpg');
    await writeFile(secret, JPEG_HEAD);
    await symlink(secret, join(dir, 'innocent.jpg'));

    // The link LIVES inside the folder; only its target betrays it. Comparing
    // the requested path instead of the real one would let this through.
    const linked = await resolveUploadPath(dir, 'innocent.jpg');
    expect(linked).toMatchObject({ ok: false });
    expect(linked.ok === false && linked.message).toMatch(/outside the allowed upload folder/);
  });

  it('reports a missing file as a plain answer, not a crash', async () => {
    const { dir } = await fixture();
    const missing = await resolveUploadPath(dir, 'nope.jpg');
    expect(missing).toMatchObject({ ok: false });
    expect(missing.ok === false && missing.message).toMatch(/No file at/);
  });
});
