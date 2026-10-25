// Apple's on-device language recognizer (NaturalLanguage, no network) for convo-card.
// stdin: a JSON array of strings. stdout: one {top, en} per string, in order.
ObjC.import("Foundation");
ObjC.import("NaturalLanguage");

function run() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const texts = JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
  return JSON.stringify(texts.map((s) => {
    const r = $.NLLanguageRecognizer.alloc.init;
    r.processString(String(s));
    const top = r.dominantLanguage;
    const h = r.languageHypothesesWithMaximum(5);
    const en = h.objectForKey("en").doubleValue;
    return { top: top ? top.js : null, en: typeof en === "number" ? en : 0 };
  }));
}
