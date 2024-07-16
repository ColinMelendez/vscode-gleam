import * as path from "path";
import * as vscode from "vscode";
import * as Parser from "web-tree-sitter";
import { highlightsQueryRaw, localsQueryRaw, tagsQueryRaw } from "./_semanticTokenQueries";
import { gleamSemanticTokenTypes } from "./_semanticTokenTypes";

const gleamSemanticTokenModifiers: string[] = []; // Placeholder for potential expansion of modifier usage.

type SemanticToken = {
  line: number;
  startCharacter: number;
  length: number;
  type: string;
  modifiers: string[];
};

const tokenTypesMap = new Map<string, number>();
const tokenModifiersMap = new Map<string, number>();

export const legend = (() => {
  gleamSemanticTokenTypes.forEach((tokenType, index) => tokenTypesMap.set(tokenType, index));

  gleamSemanticTokenModifiers.forEach((tokenModifier, index) => tokenModifiersMap.set(tokenModifier, index));

  return new vscode.SemanticTokensLegend(gleamSemanticTokenTypes, gleamSemanticTokenModifiers);
})();

/*
 * This is an implementation of the vscode.DocumentSemanticTokensProvider interface, mostly conforming
 * to the standard outlined in:
 * https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide#semantic-token-classification
 *
 * Objects of the class provide semantic tokens for the Gleam language - functioning as long-lived
 * singletons when registered as a Semantic Tokens Provider by VScode.
 *
 * The design uses a cache of parsed trees for each opened document, and uses
 * tree-sitter's incremental parsing to update the cached trees whenever a document is edited.
 * The parsing is based on the official tree-sitter-gleam grammar, and the legend, queries, and
 * parser are all procedurally derived from it.
 *
 * The implementation is made with the intention of being easily extended to remain up-to-date with
 * any changes to the tree-sitter-gleam grammar, like the possible addition of injections for nested html,
 * or revisions to the the grammar's queries.
 */
export class GleamSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  private cachedTrees: Map<string, Parser.Tree> = new Map();
  private providerReadyLock: Promise<void>;
  private parser: Parser | undefined;
  private highlightQuery: Parser.Query | undefined;
  // private localsQuery: Parser.Query | undefined;
  // private tagsQuery: Parser.Query | undefined;

  constructor() {
    // can't await things in the constructor, so we'll just await this promise at point-of-use.
    this.providerReadyLock = this.initializeParser();
  }

  private async initializeParser() {
    await Parser.init();
    this.parser = new Parser();

    const lang = await Parser.Language.load(path.join(__dirname, "../tree-sitter-gleam.wasm"));
    this.parser.setLanguage(lang);

    this.highlightQuery = lang.query(highlightsQueryRaw);

    // NOTE placeholders for other possible queries we already have access to
    // this.localsQuery = lang.query(localsQueryRaw);
    // this.tagsQuery = lang.query(tagsQueryRaw);

    // NOTE placeholder for injections
    // NOTE to add injections support from the tree-sitter-gleam grammar (if it ever gets added there),
    // an addition should be made to the bundle-queries script to generate a string for it like the others.
    // const injectionsQuery = lang.query(injectionsQueryRaw);
  }

  // build a representation of the semantic tokens in the document for vscode's SemanticTokensBuilder API
  // this function is called by vscode whenever it needs to update the semantic tokens for a document.
  async provideDocumentSemanticTokens(document: vscode.TextDocument, _: vscode.CancellationToken) {
    const builder = new vscode.SemanticTokensBuilder(legend);

    const docText = document.getText();
    const docURI = document.uri.toString();

    // wait for the initialization or updates to complete
    await this.providerReadyLock;

    // get the tree for this document from the cache
    let tree = this.cachedTrees.get(docURI);
    if (!tree) {
      // If there's no cached tree for this document, parse the text from scratch and cache it.
      tree = this.parser!.parse(docText);
      this.cachedTrees.set(docURI, tree);
    } else {
      // if the the cache contains an (assumed) updated tree, use it for an incremental parse.
      tree = this.parser!.parse(docText, tree);
      this.cachedTrees.set(docURI, tree);
    }

    // get an array of matches using tree-sitter-gleam's highlights query
    const highlightMatches = this.highlightQuery!.matches(tree.rootNode);

    // convert the matches to semantic tokens for VSCode to consume
    let tokens = this._mapTSMatchesToSemanticTokens(highlightMatches);
    tokens.forEach((token) =>
      builder.push(
        token.line,
        token.startCharacter,
        token.length,
        this._encodeTokenType(token.type),
        this._encodeTokenModifiers(token.modifiers)
      )
    );

    return builder.build();
  }

  // convert the token type to an integer representing its index in the legend
  private _encodeTokenType(tokenType: string): number {
    if (tokenTypesMap.has(tokenType)) {
      return tokenTypesMap.get(tokenType)!;
    } else if (tokenType === "notInLegend") {
      return tokenTypesMap.size + 2;
    }
    return 0;
  }

  //NOTE: essentially unused for now (no modifiers)
  // convert the token type modifiers to a bitmask
  private _encodeTokenModifiers(strTokenModifiers: string[]): number {
    let result = 0;
    for (let i = 0; i < strTokenModifiers.length; i++) {
      const tokenModifier = strTokenModifiers[i];
      if (tokenModifiersMap.has(tokenModifier)) {
        result = result | (1 << tokenModifiersMap.get(tokenModifier)!);
      } else if (tokenModifier === "notInLegend") {
        result = result | (1 << (tokenModifiersMap.size + 2));
      }
    }
    return result;
  }

  private _mapTSMatchesToSemanticTokens(matches: Parser.QueryMatch[]): SemanticToken[] {
    const tokens = matches
      .flatMap((match) => match.captures)
      .flatMap((capture) => {
        const type = capture.name;
        const start = capture.node.startPosition;
        const end = capture.node.endPosition;

        // make sure that the token is valid just in case. if it's not, return an empty token array
        if (!tokenTypesMap.has(type)) {
          return [];
        }

        const token: SemanticToken = {
          line: start.row,
          startCharacter: start.column,
          length: end.column - start.column,
          type: type,
          modifiers: [], // Placeholder for potential expansion of modifier usage.
        };

        // if the token is spanning multiple lines in the editor, it needs to be divided
        // into multiple tokens for vscode to handle.
        if (start.row > end.row) {
          return this._splitLine(token, start, end);
        }

        return [token];
      });

    return tokens;
  }

  // split a semantic token that spans multiple lines into multiple tokens to make VScode happy
  private _splitLine(token: SemanticToken, start: Parser.Point, end: Parser.Point): SemanticToken[] {
    // VScode docs specify 65_535 as a limit that you "should" not exceed.
    const maxLength = 65_535;
    const offset = end.row - start.row;
    let tokens: SemanticToken[] = [];

    // make a token for the first line that the token is on, starting from it's first character
    tokens.push({
      line: start.row,
      startCharacter: start.column,
      length: maxLength,
      type: token.type,
      modifiers: token.modifiers,
    });

    // make tokens for any non-terminal intermediate lines that the original token spans
    for (let i = 1; i < offset; i++) {
      const middleToken: SemanticToken = {
        line: start.row + i,
        startCharacter: 0,
        length: maxLength,
        type: token.type,
        modifiers: token.modifiers,
      };
      tokens.push(middleToken);
    }

    // make a token for the last line that the token is on, ending with it's last character
    tokens.push({
      line: end.row,
      startCharacter: 0,
      length: end.column,
      type: token.type,
      modifiers: token.modifiers,
    });
    return tokens;
  }

  async updateCachedTree(e: vscode.TextDocumentChangeEvent) {
    this.providerReadyLock = (async () => {
      const docURI = e.document.uri.toString();
      let tree = this.cachedTrees.get(docURI);

      // if there's a tree for this document, apply the changes to it otherwise do nothing
      if (tree) {
        e.contentChanges.forEach((change) => {
          // get get the information about the change
          const start = change.rangeOffset;
          const oldEnd = change.rangeOffset + change.rangeLength;
          const newEnd = change.rangeOffset + change.text.length;
          const startPosition = e.document.positionAt(start);
          const oldEndPosition = e.document.positionAt(oldEnd);
          const newEndPosition = e.document.positionAt(newEnd);

          // apply the change to the tree
          tree!.edit({
            startIndex: start,
            oldEndIndex: oldEnd,
            newEndIndex: newEnd,
            startPosition: { row: startPosition.line, column: startPosition.character },
            oldEndPosition: { row: oldEndPosition.line, column: oldEndPosition.character },
            newEndPosition: { row: newEndPosition.line, column: newEndPosition.character },
          });
        });
      }
    })();
  }
}
