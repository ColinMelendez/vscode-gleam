/* This is a build script to generate string variables from the tree-sitter-gleam query files so
*  we can bundle strings with the extension, rather than importing and reading the files at runtime.
*  It also gives a bit more flexibility to edit and pre-process the query content without burdening
*  the extension initialization process, and makes it easier to debug them.
*/
console.log("bundling queries...");

const fs = require('fs');

// destination file path (dev) (imports will need to reflect this)
const targetFilePath = 'src/_semanticTokenQueries.ts'

// path to the source files
const highlightsSourcePath ='node_modules/tree-sitter-gleam/queries/highlights.scm';
const localsSourcePath = 'node_modules/tree-sitter-gleam/queries/locals.scm';
const tagsSourcePath = 'node_modules/tree-sitter-gleam/queries/tags.scm';

// read the content of the source files
const highlightsFileContent = fs.readFileSync(highlightsSourcePath, 'utf-8');
const localsFileContent = fs.readFileSync(localsSourcePath, 'utf-8');
const tagsFileContent = fs.readFileSync(tagsSourcePath, 'utf-8');

// escape possible backticks in the file content for template literals
const escapedHighlightsContent = highlightsFileContent.replace(/`/g, '\\`');
const escapedLocalsContent = localsFileContent.replace(/`/g, '\\`');
const escapedTagsContent = tagsFileContent.replace(/`/g, '\\`');

// set up the variable declarations for the generated file
const highlightsQueryVar = `\nexport const highlightsQueryRaw = \`${escapedHighlightsContent}\`;\n`;
const localsQueryVar = `\nexport const localsQueryRaw = \`${escapedLocalsContent}\`;\n`;
const tagsQueryVar = `\nexport const tagsQueryRaw = \`${escapedTagsContent}\`;\n`;

const headerComment = `// This file is auto-generated by bundle-queries.js as a build step.\n// Do not edit directly.\n`;

const targetFileContents = `${headerComment}\n${highlightsQueryVar}${localsQueryVar}${tagsQueryVar}`;

fs.writeFileSync(targetFilePath, targetFileContents);

console.log("done");
