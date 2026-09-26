// QVAC AI Trivia Duel — core logic.
// action "question": generate a trivia question + correct answer for a category.
// action "judge": compare the user's answer to the correct answer.

import { completion } from "@qvac/sdk";

function stripLabel(line, labels) {
  for (const l of labels) {
    const re = new RegExp(`^\\s*\\**\\s*${l}\\s*:?\\s*`, "i");
    if (re.test(line)) return line.replace(re, "").trim();
  }
  return null;
}

function parseQA(raw) {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  let question = "";
  let answer = "";
  for (const line of lines) {
    const q = stripLabel(line, ["question"]);
    if (q !== null && !question) { question = q; continue; }
    const a = stripLabel(line, ["answer", "correct answer"]);
    if (a !== null && !answer) { answer = a; continue; }
  }
  if (!question || !answer) {
    // Fallback: assume first line is question, look for a line containing "answer"
    if (!question) question = lines[0] || "";
    const aLine = lines.find((l) => /answer/i.test(l));
    if (!answer && aLine) answer = aLine.replace(/^.*answer\s*:?\s*/i, "").trim();
  }
  return { question: question.replace(/["*]/g, "").trim(), answer: answer.replace(/["*.]/g, "").trim() };
}

async function askModel(modelId, system, user, opts) {
  const run = completion({
    modelId,
    history: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: true,
    completionOpts: opts,
  });
  let text = "";
  for await (const token of run.tokenStream) text += token;
  return text.trim();
}

export async function generate(modelId, body) {
  const action = body.action || "question";

  if (action === "question") {
    const category = (body.category || "").trim();
    if (!category) return { error: "Please enter a trivia category." };

    const raw = await askModel(
      modelId,
      `You write short trivia questions. Given a category, output exactly two lines in this exact format, nothing else:\nQuestion: <one factual trivia question about the category>\nAnswer: <the short correct answer, a few words max>\n\nExample:\nCategory: 1990s movies\nQuestion: Which 1994 film features a box of chocolates as a recurring metaphor for life?\nAnswer: Forrest Gump`,
      `Category: ${category}`,
      { temperature: 0.8, maxTokens: 150 }
    );
    let { question, answer } = parseQA(raw);
    if (!question || question.length < 5) question = `Name one well-known fact about ${category}.`;
    if (!answer) answer = "(answer unclear — try another category)";
    return { question, correctAnswer: answer };
  }

  if (action === "judge") {
    const { question, correctAnswer, userAnswer } = body;
    if (!userAnswer || !userAnswer.trim()) return { error: "Please enter your answer." };

    const raw = await askModel(
      modelId,
      `You are a trivia judge. Given a question, the correct answer, and a player's answer, decide if the player's answer is correct (allow for minor spelling/phrasing differences, but the core fact must match). Reply in exactly this format:\nVerdict: CORRECT or INCORRECT\nNote: <one short encouraging sentence explaining why>\n\nExample:\nQuestion: What is the capital of France?\nCorrect answer: Paris\nPlayer answer: paris\nVerdict: CORRECT\nNote: Yes, Paris is exactly right!`,
      `Question: ${question}\nCorrect answer: ${correctAnswer}\nPlayer answer: ${userAnswer}`,
      { temperature: 0.3, maxTokens: 100 }
    );

    const verdictMatch = raw.match(/verdict\s*:?\s*(correct|incorrect)/i);
    const noteMatch = raw.match(/note\s*:?\s*(.+)/i);
    // Deterministic override: if the player's answer literally contains the correct
    // answer (or vice versa), trust that over the model's own judgment — the small
    // model sometimes contradicts an obviously matching answer.
    const normalize = (s) => s.trim().toLowerCase().replace(/^(the|a|an)\s+/, "");
    const literalMatch = normalize(userAnswer).includes(normalize(correctAnswer)) ||
      normalize(correctAnswer).includes(normalize(userAnswer));
    let isCorrect;
    if (literalMatch) {
      isCorrect = true;
    } else if (verdictMatch) {
      isCorrect = /^correct/i.test(verdictMatch[1]);
    } else {
      isCorrect = false;
    }
    const modelSaidIncorrect = verdictMatch && !/^correct/i.test(verdictMatch[1]);
    const note = literalMatch && modelSaidIncorrect
      ? `Yes, that matches the correct answer (${correctAnswer})!`
      : noteMatch
        ? noteMatch[1].replace(/["*]/g, "").trim()
        : (isCorrect ? "Nice, that matches!" : `Not quite — the correct answer was ${correctAnswer}.`);

    return { isCorrect, note };
  }

  return { error: "Unknown action." };
}
