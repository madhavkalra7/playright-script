/**
 * CSV Handler Utility
 * Reads and writes the prompt dataset CSV file.
 */

const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

/**
 * Read CSV file and return array of row objects.
 * @param {string} filePath
 * @returns {Object[]}
 */
function readCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const records = parse(content, {
    columns: true,           // First row is header
    skip_empty_lines: true,
    relax_quotes: true,
    trim: true
  });
  return records;
}

/**
 * Write array of row objects back to CSV file.
 * Preserves column order from the first row's keys.
 * @param {string} filePath
 * @param {Object[]} records
 */
function writeCSV(filePath, records) {
  if (!records || records.length === 0) return;

  const output = stringify(records, {
    header: true,
    columns: Object.keys(records[0]),
    quoted_string: true,
    cast: {
      string: (value) => (value === null || value === undefined ? '' : String(value))
    }
  });

  fs.writeFileSync(filePath, output, 'utf-8');
}

module.exports = { readCSV, writeCSV };
