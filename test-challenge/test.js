/**
 * ==============================================================================
 * PROBLEM STATEMENT: Responsive User Profile Card Component
 * ==============================================================================
 * 
 * Your task is to build a responsive, modern User Profile Card using HTML and CSS.
 * 
 * REQUIRED FILES:
 * 1. index.html - The markup structure of the profile card.
 * 2. styles.css - The styling rules and theme variables.
 * 
 * REQUIREMENTS:
 * - index.html must be a valid HTML5 document linking to "styles.css".
 * - Inside <body>, create a container with class "profile-card".
 * - Inside the card, include:
 *     - An <img> tag with class "avatar" and an alt attribute.
 *     - A heading (h1 or h2) with class "user-name" containing the person's name.
 *     - A paragraph or span with class "user-bio" containing a short biography.
 *     - A <button> with id "theme-btn" for switching between dark/light themes.
 * - styles.css must define:
 *     - CSS custom properties (variables) in :root (e.g. --bg-color, --card-bg, --primary-color).
 *     - Rules for ".profile-card" using display: flex (or grid), border-radius, and box-shadow.
 * ==============================================================================
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (filename) => {
  const filePath = path.join(root, filename);
  if (!existsSync(filePath)) {
    throw new Error(`Expected file "${filename}" to exist, but it was not found.`);
  }
  return readFileSync(filePath, 'utf8');
};

test('1. index.html is valid HTML5 and links to styles.css', () => {
  const html = read('index.html');
  assert.ok(html.trim().length > 0, 'index.html is empty');
  assert.match(html, /<!doctype\s+html>/i, 'index.html must have <!DOCTYPE html>');
  assert.match(html, /<link[^>]+rel=["']stylesheet["'][^>]+href=["']styles\.css["']/i, 'index.html must link styles.css');
});

test('2. index.html contains .profile-card and an .avatar image', () => {
  const html = read('index.html');
  assert.match(html, /class=["'][^"']*profile-card[^"']*["']/, 'Missing element with class "profile-card"');
  assert.match(html, /<img[^>]+class=["'][^"']*avatar[^"']*["'][^>]*>/i, 'Missing <img> with class "avatar"');
  assert.match(html, /<img[^>]+alt=["'][^"']+["']/i, '<img> avatar must have a descriptive alt attribute');
});

test('3. index.html displays .user-name heading and .user-bio description', () => {
  const html = read('index.html');
  assert.match(html, /<h[12][^>]+class=["'][^"']*user-name[^"']*["'][^>]*>[\s\S]+?<\/h[12]>/i, 'Missing heading with class "user-name"');
  assert.match(html, /<[^>]+class=["'][^"']*user-bio[^"']*["'][^>]*>[\s\S]+?<\/[^>]+>/i, 'Missing element with class "user-bio"');
});

test('4. index.html contains a button with id #theme-btn', () => {
  const html = read('index.html');
  assert.match(html, /<button[^>]+id=["']theme-btn["'][^>]*>[\s\S]+?<\/button>/i, 'Missing <button> with id "theme-btn"');
});

test('5. styles.css defines CSS custom properties in :root', () => {
  const css = read('styles.css');
  assert.ok(css.trim().length > 0, 'styles.css is empty');
  assert.match(css, /:root\s*\{[^}]*--[a-zA-Z0-9_-]+\s*:/, 'styles.css must declare CSS variables in :root');
  assert.match(css, /--bg/i, 'styles.css should declare a background color variable in :root (e.g. --bg-color)');
});

test('6. styles.css styles .profile-card with modern layout and shadow', () => {
  const css = read('styles.css');
  assert.match(css, /\.profile-card\s*\{[^}]*\}/, 'styles.css must define styles for .profile-card');
  assert.match(css, /border-radius\s*:/, '.profile-card or components must define border-radius');
  assert.match(css, /box-shadow\s*:/, '.profile-card must define a box-shadow');
});
