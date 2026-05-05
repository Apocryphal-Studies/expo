import type { StackFrame } from 'stacktrace-parser';

export type CodeFrame = {
  content: string;
  location?: {
    row: number;
    column: number;
    [key: string]: any;
  };
  fileName: string;
};

export type MetroStackFrame = StackFrame & { collapse?: boolean };
export type Stack = StackFrame[];

type StackFrameInput = {
  file?: string | null;
  lineNumber?: number | null;
  column?: number | null;
  methodName?: string | null;
};

type IntermediateStackFrame = StackFrameInput & {
  collapse?: boolean;
};

type StackFrameOutput = IntermediateStackFrame;

const debug = require('debug')('expo:start:server:metro:symbolicate') as typeof console.log;

export const createSymbolicate = ({
  projectRoot,
  metroConfig,
  rewriteRequestUrl,
  explodedSourceMapForBundleOptions,
  parseOptions,
}: {
  projectRoot: string;
  metroConfig: ConfigT;
  rewriteRequestUrl: (url: string) => string;
  explodedSourceMapForBundleOptions: (bundleOptions: BundleOptions) => Promise<ExplodedSourceMap>;
  parseOptions: (url: string) => BundleOptions;
}) => {
  function rewriteAndNormalizeUrl(requestUrl: string): string {
    return jscSafeUrl.toNormalUrl(rewriteRequestUrl(jscSafeUrl.toNormalUrl(requestUrl)));
  }

  function getCodeFrame(urls: Set<string>, symbolicatedStack: readonly StackFrameOutput[]) {
    const allFramesCollapsed = symbolicatedStack.every(({ collapse }) => collapse);

    for (let i = 0; i < symbolicatedStack.length; i++) {
      const { collapse, column, file, lineNumber } = symbolicatedStack[i];

      if (
        // If all the frames are collapsed then we should ignore the collapse flag
        // and always show the first valid frame.
        (!allFramesCollapsed && collapse) ||
        lineNumber == null ||
        (file != null && urls.has(file))
      ) {
        continue;
      }

      const fileAbsolute = path.resolve(projectRoot, file ?? '');
      try {
        return {
          content: codeFrameColumns(
            fs.readFileSync(fileAbsolute, 'utf8'),
            {
              // Metro returns 0 based columns but codeFrameColumns expects 1-based columns
              start: { column: column == null ? undefined : column + 1, line: lineNumber },
            },
            { forceColor: true }
          ),
          location: {
            row: lineNumber,
            column,
          },
          fileName: file,
        };
      } catch (error) {
        debug(`Failed to read code frame from file`, fileAbsolute, error);
      }
    }

    return null;
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      debug('Start symbolication');

      const parsedBody = (await parseJsonBody(req)) as {
        stack: readonly StackFrameInput[];
        extraData: { [key: string]: unknown };
      };

      const rewriteAndNormalizeStackFrame = <T extends StackFrameInput>(
        frame: T,
        lineNumber: number
      ): T => {
        invariant(
          frame != null && typeof frame === 'object',
          'Bad stack frame at line %d, expected object, received: %s',
          lineNumber,
          typeof frame
        );
        const frameFile = frame.file;
        if (typeof frameFile === 'string' && frameFile.includes('://')) {
          return {
            ...frame,
            file: rewriteAndNormalizeUrl(frameFile),
          };
        }
        return frame;
      };

      const stack = parsedBody.stack.map(rewriteAndNormalizeStackFrame);
      // In case of multiple bundles / HMR, some stack frames can have different URLs from others
      const urls = new Set<string>();

      stack.forEach((frame) => {
        // These urls have been rewritten and normalized above.
        const sourceUrl = frame.file;
        // Skip `/debuggerWorker.js` which does not need symbolication.
        if (
          sourceUrl != null &&
          !urls.has(sourceUrl) &&
          !sourceUrl.endsWith('/debuggerWorker.js') &&
          sourceUrl.startsWith('http')
        ) {
          urls.add(sourceUrl);
        }
      });

      debug('Getting source maps for symbolication');
      const sourceMaps = await Promise.all(
        Array.from(urls.values()).map((normalizedUrl) =>
          explodedSourceMapForBundleOptions(parseOptions(normalizedUrl))
        )
      );

      debug('Performing fast symbolication');
      const symbolicatedStack = await symbolicate(
        stack,
        zip(urls.values(), sourceMaps),
        metroConfig,
        parsedBody.extraData ?? {}
      );

      debug('Symbolication done');
      res.end(
        JSON.stringify({
          codeFrame: getCodeFrame(urls, symbolicatedStack),
          stack: symbolicatedStack,
        })
      );
    } catch (error) {
      debug('Symbolication failed', error);
      res.statusCode = 500;
      if (error instanceof Error) {
        res.end(JSON.stringify({ error: error.message }));
      } else {
        res.end(JSON.stringify({ error: String(error) }));
      }
    }
  };
};

function* zip<X, Y>(xs: Iterable<X>, ys: Iterable<Y>): Iterable<[X, Y]> {
  const ysIter: Iterator<Y> = ys[Symbol.iterator]();
  for (const x of xs) {
    const y = ysIter.next();
    if (y.done) {
      return;
    }
    yield [x, y.value];
  }
}
