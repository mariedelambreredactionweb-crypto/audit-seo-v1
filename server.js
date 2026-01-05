import express from "express";
import { fetch } from "undici";
import * as cheerio from "cheerio";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ✅ Autorise uniquement ton site
app.use(
  cors({
    origin: ["https://marie-redacweb.fr", "https://www.marie-redacweb.fr"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Audit SEO API V1" });
});

function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeForMatch(s) {
  // lowercase + no accents + keep letters/numbers/spaces only
  return stripAccents(cleanText(s).toLowerCase()).replace(/[^\p{L}\p{N}\s]/gu, "");
}

function charCount(s) {
  return Array.from(cleanText(s)).length;
}

function wordsCount(s) {
  const t = cleanText(s);
  if (!t) return 0;
  return t.split(" ").length;
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
        accept: "text/html,application/xhtml+xml",
      },
    });

    const contentType = resp.headers.get("content-type") || "";
    const status = resp.status;

    if (!resp.ok) throw new Error(`FETCH_HTTP_${status}`);
    if (!contentType.includes("text/html")) throw new Error("FETCH_NOT_HTML");

    const html = await resp.text();
    return { html, status, contentType };
  } finally {
    clearTimeout(timeout);
  }
}

function extractFirstParagraph($) {
  const ps = $("p")
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter((t) => t.length >= 40);
  return ps[0] || "";
}

function extractLastParagraph($) {
  const ps = $("p")
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter((t) => t.length >= 40);
  return ps.length ? ps[ps.length - 1] : "";
}

function extractParagraphs($) {
  return $("p")
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter((t) => t.length > 0);
}

function extractImages($) {
  return $("img")
    .map((_, el) => {
      const alt = cleanText($(el).attr("alt"));
      const src = cleanText($(el).attr("src"));
      return { src, alt };
    })
    .get()
    .filter((img) => img.src.length > 0);
}

/**
 * ✅ Levenshtein distance (petit, suffisant pour tolérer 1 faute)
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const m = a.length;
  const n = b.length;
  const dp = new Array(n + 1);

  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1, // deletion
        dp[j - 1] + 1, // insertion
        prev + cost // substitution
      );
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * ✅ Tokenisation "mots-clés principaux" : on garde des mots utiles
 * - supprime les petits mots (<=2)
 * - garde dès 3 caractères
 */
function keywordTokens(keyword) {
  const k = normalizeForMatch(keyword);
  return k
    .split(" ")
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);
}

/**
 * ✅ Check présence d’un token dans un texte
 * - match direct (includes)
 * - sinon match fuzzy : tolère 1 faute si token assez long
 */
function tokenPresentFuzzy(text, token) {
  const t = normalizeForMatch(text);
  const tok = normalizeForMatch(token);
  if (!t || !tok) return false;

  if (t.includes(tok)) return true;

  // Match "mot par mot" en fuzzy
  const words = t.split(" ").filter(Boolean);

  // seuil de tolérance : 1 faute si token >= 6, sinon 0
  const maxDist = tok.length >= 6 ? 1 : 0;

  if (maxDist === 0) return false;

  for (const w of words) {
    if (Math.abs(w.length - tok.length) > maxDist) continue;
    if (levenshtein(w, tok) <= maxDist) return true;
  }
  return false;
}

/**
 * ✅ Tous les tokens doivent apparaître (avec tolérance fautes) dans la zone
 */
function allTokensPresentFuzzy(text, tokens) {
  if (!tokens.length) return false;
  return tokens.every((tok) => tokenPresentFuzzy(text, tok));
}

function statusGlobalFromChecks(checks) {
  // Structurants : si rouge => global rouge
  const structurants = new Set(["title", "h1", "keyword_structure_tokens"]);
  const hasRedStruct = checks.some((c) => c.status === "red" && structurants.has(c.id));
  if (hasRedStruct) return "red";

  const hasRed = checks.some((c) => c.status === "red");
  if (hasRed) return "orange";

  const hasOrange = checks.some((c) => c.status === "orange");
  if (hasOrange) return "orange";

  return "green";
}

function globalMessage(status) {
  if (status === "green") {
    return {
      title: "🟢 Tu es sur la bonne voie.",
      body: "Les bases SEO éditoriales de ta page sont solides.",
      cta: "hide",
    };
  }
  if (status === "orange") {
    return {
      title: "🟠 Les fondations sont là, mais peuvent être renforcées.",
      body: "Quelques ajustements peuvent améliorer la clarté et l’impact de ta page.",
      cta: "show",
    };
  }
  return {
    title: "🔴 Le fil conducteur n’est pas encore assez explicite aux endroits clés.",
    body:
      "Rien de grave : on va surtout retravailler la structure (intro, titres, conclusion).\n👉 Si tu veux en parler et savoir par où commencer, tu peux réserver un appel découverte offert.",
    cta: "show",
  };
}

function buildMessagesForCheck(checkId, status, extra = {}) {
  const SERP_HINT = "👉 Tu peux retravailler ce point avec le simulateur de SERP.";
  const CALL_HINT = "👉 Si tu veux en parler lors d’un appel découverte offert, je t’accueille avec plaisir.";

  switch (checkId) {
    case "title": {
      if (status === "green") {
        return {
          message: "Ton title est présent, clair et bien dimensionné.\nIl aide Google à comprendre le sujet de ta page.",
          action: "",
        };
      }
      if (status === "orange") {
        return {
          message:
            "Ton title est présent, mais sa longueur peut être optimisée.\nTrop court ou trop long, il risque d’être tronqué dans les résultats de recherche.",
          action: SERP_HINT,
        };
      }
      return {
        message: "Aucun title clair n’a été détecté.\nC’est un repère essentiel pour indiquer le sujet principal.",
        action: "👉 Priorité : écrire un title clair et centré sur ton sujet.\n" + SERP_HINT,
      };
    }

    case "meta_description": {
      if (status === "green") {
        return { message: "Ta meta description est bien dimensionnée.\nElle aide à donner envie de cliquer.", action: "" };
      }
      if (status === "orange") {
        return {
          message:
            "Ta meta description est présente, mais sa longueur peut être optimisée.\nElle risque d’être tronquée ou trop courte dans Google.",
          action: SERP_HINT,
        };
      }
      return {
        message:
          "Aucune meta description n’a été détectée.\nCe n’est pas bloquant, mais dommage pour le taux de clic.",
        action: SERP_HINT,
      };
    }

    case "h1": {
      if (status === "green") {
        return { message: "Ton H1 est unique et bien aligné avec le sujet de ta page.\nIl pose clairement le cadre.", action: "" };
      }
      if (status === "orange") {
        return { message: "Ton H1 est unique, mais il pourrait être plus précis ou mieux aligné avec la requête.", action: "" };
      }
      return {
        message:
          "Aucun H1 clair (ou plusieurs H1) ont été détectés.\nCela rend le sujet plus difficile à identifier.",
        action: "👉 Priorité : un seul H1 centré sur l’idée principale.",
      };
    }

    // ✅ Nouveau critère : tokens (moins robotique)
    case "keyword_structure_tokens": {
      const missing = extra?.missing?.length ? extra.missing.join(", ") : "intro / H2 / conclusion";
      const tokens = extra?.tokens?.length ? extra.tokens.join(", ") : "mots-clés principaux";

      if (status === "green") {
        return {
          message:
            `Tes mots-clés principaux sont bien posés aux endroits clés : intro, au moins un H2, et conclusion.\nTokens repérés : ${tokens}.`,
          action: "",
        };
      }
      if (status === "orange") {
        return {
          message:
            `Le sujet est présent, mais il manque un repère dans la structure.\nÀ renforcer : ${missing}.\nTokens attendus : ${tokens}.`,
          action:
            "👉 Astuce : pose les mots-clés principaux aux endroits clés, et utilise des variantes ailleurs.",
        };
      }
      return {
        message:
          `Tes mots-clés principaux ne sont pas encore posés aux endroits clés.\nTokens attendus : ${tokens}.`,
        action: "👉 Priorité : intro + un H2 + conclusion.\n" + CALL_HINT,
      };
    }

    case "structure": {
      if (status === "green") return { message: "La page est bien structurée.\nLes sous-titres facilitent la lecture.", action: "" };
      if (status === "orange") return { message: "Une structure est présente, mais elle pourrait être renforcée.", action: "" };
      return { message: "La page manque de structure claire.\nElle ressemble à un bloc de texte continu.", action: "👉 Action simple : découper avec des H2." };
    }

    case "images_alt": {
      if (status === "green") return { message: "Les images sont bien utilisées et les attributs alt sont renseignés.\nBon point.", action: "" };
      if (status === "orange") return { message: "Des images sont présentes, mais certains attributs alt manquent.", action: "👉 Action simple : décrire brièvement chaque image." };
      return { message: "Aucune image n’a été détectée.\nUne image peut aider à aérer et contextualiser le contenu.", action: "" };
    }

    case "readability": {
      if (status === "green") return { message: "Le texte est agréable à lire.\nLes paragraphes sont bien aérés.", action: "" };
      if (status === "orange") return { message: "Certains passages sont un peu longs et pourraient être aérés.", action: "" };
      return { message: "La lecture est difficile : les paragraphes sont trop denses.", action: "👉 Astuce : raccourcir, aérer, simplifier." };
    }

    case "lexical": {
      if (status === "green") return { message: "Le champ lexical est cohérent avec ta requête.\nLe sujet est bien contextualisé.", action: "" };
      if (status === "orange") return { message: "Le champ lexical peut être enrichi pour renforcer le contexte.", action: "👉 Action simple : ajouter des mots naturellement liés au sujet." };
      return { message: "Le champ lexical est trop pauvre pour bien poser le contexte.", action: "👉 Priorité : enrichir sans sur-optimiser." };
    }

    default:
      return { message: "", action: "" };
  }
}

function computeChecks(extracted, keyword) {
  const checks = [];

  // 1) Title
  const title = extracted.title || "";
  const titleLen = charCount(title);
  let titleStatus = "red";
  if (titleLen > 0) titleStatus = titleLen >= 45 && titleLen <= 60 ? "green" : "orange";

  {
    const { message, action } = buildMessagesForCheck("title", titleStatus);
    checks.push({
      id: "title",
      label: "Title — clarté & longueur",
      status: titleStatus,
      message,
      action,
      data: { length: titleLen, value: title },
    });
  }

  // 2) Meta description (corrigée)
  const meta = extracted.meta_description || "";
  const metaLen = charCount(meta);

  let metaStatus = "red";
  if (metaLen > 0) {
    if (metaLen >= 120 && metaLen <= 160) metaStatus = "green";
    else if ((metaLen >= 70 && metaLen <= 119) || (metaLen >= 161 && metaLen <= 200)) metaStatus = "orange";
    else metaStatus = "orange";
  }

  {
    const { message, action } = buildMessagesForCheck("meta_description", metaStatus);
    checks.push({
      id: "meta_description",
      label: "Meta description — longueur",
      status: metaStatus,
      message,
      action,
      data: { length: metaLen, value: meta },
    });
  }

  // 3) H1
  const h1s = extracted.h1s || [];
  let h1Status = "red";
  if (h1s.length === 1) h1Status = "green";
  else if (h1s.length > 1) h1Status = "red";

  {
    const { message, action } = buildMessagesForCheck("h1", h1Status);
    checks.push({
      id: "h1",
      label: "H1 — sujet principal",
      status: h1Status,
      message,
      action,
      data: { count: h1s.length, values: h1s },
    });
  }

  // 4) ✅ Mots-clés principaux dans la structure (intro + ≥1 H2 + conclusion)
  const tokens = keywordTokens(keyword);

  const intro = extracted.intro || "";
  const conclusion = extracted.conclusion || "";
  const h2s = extracted.h2s || [];

  const okIntro = intro ? allTokensPresentFuzzy(intro, tokens) : false;
  const okH2 = h2s.length ? h2s.some((h2) => allTokensPresentFuzzy(h2, tokens)) : false;
  const okConc = conclusion ? allTokensPresentFuzzy(conclusion, tokens) : false;

  const missing = [];
  if (!okIntro) missing.push("intro");
  if (!okH2) missing.push("H2");
  if (!okConc) missing.push("conclusion");

  const okCount = [okIntro, okH2, okConc].filter(Boolean).length;

  let ksStatus = "red";
  if (okCount === 3) ksStatus = "green";
  else if (okCount === 2) ksStatus = "orange";

  {
    const { message, action } = buildMessagesForCheck("keyword_structure_tokens", ksStatus, {
      missing,
      tokens,
    });

    checks.push({
      id: "keyword_structure_tokens",
      label: "Mots-clés principaux dans la structure (intro + H2 + conclusion)",
      status: ksStatus,
      message,
      action,
      data: { tokens, ok_intro: okIntro, ok_h2: okH2, ok_conclusion: okConc, missing },
    });
  }

  // 5) Structure globale (H2 count)
  const h2Count = h2s.length;
  let structureStatus = "red";
  if (h2Count >= 2) structureStatus = "green";
  else if (h2Count === 1) structureStatus = "orange";

  {
    const { message, action } = buildMessagesForCheck("structure", structureStatus);
    checks.push({
      id: "structure",
      label: "Structure globale (H2)",
      status: structureStatus,
      message,
      action,
      data: { h2_count: h2Count },
    });
  }

  // 6) Images & alt
  const imgCount = extracted.images_count || 0;
  const missingAlt = extracted.images_missing_alt_count || 0;
  let imgStatus = "red";
  if (imgCount > 0) imgStatus = missingAlt > 0 ? "orange" : "green";

  {
    const { message, action } = buildMessagesForCheck("images_alt", imgStatus);
    checks.push({
      id: "images_alt",
      label: "Images & attributs alt",
      status: imgStatus,
      message,
      action,
      data: { images_count: imgCount, images_missing_alt_count: missingAlt },
    });
  }

  // 7) Lisibilité
  const longP = extracted.long_paragraphs_count || 0;
  let readStatus = "green";
  if (longP >= 3) readStatus = "red";
  else if (longP >= 1) readStatus = "orange";

  {
    const { message, action } = buildMessagesForCheck("readability", readStatus);
    checks.push({
      id: "readability",
      label: "Lisibilité (paragraphes)",
      status: readStatus,
      message,
      action,
      data: {
        avg_words_per_paragraph: extracted.avg_words_per_paragraph || 0,
        long_paragraphs_count: longP,
      },
    });
  }

  // 8) Champ lexical (critère distinct)
  const generic = ["google", "referencement", "seo", "site", "page", "contenu", "visibilite"];
  const expected = Array.from(new Set([...generic, ...tokens.filter((t) => t.length >= 4)]));

  const bodyText = normalizeForMatch(
    (extracted.title || "") +
      " " +
      (extracted.meta_description || "") +
      " " +
      (extracted.h1s || []).join(" ") +
      " " +
      (extracted.h2s || []).join(" ") +
      " " +
      (extracted.intro || "") +
      " " +
      (extracted.conclusion || "")
  );

  const found = expected.filter((term) => bodyText.includes(term));
  let lexStatus = "red";
  if (found.length >= 4) lexStatus = "green";
  else if (found.length >= 2) lexStatus = "orange";

  {
    const { message, action } = buildMessagesForCheck("lexical", lexStatus);
    checks.push({
      id: "lexical",
      label: "Champ lexical lié à la requête",
      status: lexStatus,
      message,
      action,
      data: { found, expected, found_count: found.length },
    });
  }

  return checks;
}

app.post("/api/audit", async (req, res) => {
  const { url, keyword } = req.body || {};

  if (!url || !keyword) {
    return res.status(400).json({
      error: { code: "INVALID_INPUT", message: "url et keyword sont requis" },
    });
  }

  if (!isValidHttpUrl(url)) {
    return res.status(400).json({
      error: { code: "INVALID_URL", message: "URL invalide (http/https requis)" },
    });
  }

  try {
    const { html, status, contentType } = await fetchHtml(url);

    const $ = cheerio.load(html);

    const title = cleanText($("title").first().text());
    const metaDesc = cleanText($('meta[name="description"]').attr("content"));
    const h1s = $("h1")
      .map((_, el) => cleanText($(el).text()))
      .get()
      .filter(Boolean);

    const h2s = $("h2")
      .map((_, el) => cleanText($(el).text()))
      .get()
      .filter(Boolean);

    const intro = extractFirstParagraph($);
    const conclusion = extractLastParagraph($);
    const paragraphs = extractParagraphs($);
    const images = extractImages($);

    const paragraphWordCounts = paragraphs.map(wordsCount);
    const longParagraphsCount = paragraphWordCounts.filter((n) => n > 120).length;
    const avgWordsPerParagraph = paragraphWordCounts.length
      ? Math.round(paragraphWordCounts.reduce((a, b) => a + b, 0) / paragraphWordCounts.length)
      : 0;

    const extracted = {
      title,
      meta_description: metaDesc,
      h1s,
      h2s,
      intro,
      conclusion,
      images_count: images.length,
      images_missing_alt_count: images.filter((img) => !img.alt).length,
      avg_words_per_paragraph: avgWordsPerParagraph,
      long_paragraphs_count: longParagraphsCount,
    };

    const checks = computeChecks(extracted, keyword);
    const status_global = statusGlobalFromChecks(checks);
    const global_message = globalMessage(status_global);

    const closing_cta = {
      text:
        "Si certains points te semblent flous ou difficiles à corriger seul, c’est exactement ce qu’on travaille ensemble en coaching SEO éditorial : clarifier, structurer et te rendre autonome.\n👉 Tu peux me contacter pour en parler lors d’un appel découverte offert.",
      show: status_global !== "green",
    };

    return res.json({
      input: { url, keyword },
      meta: { http_status: status, content_type: contentType },
      status_global,
      global_message,
      checks,
      closing_cta,
    });
  } catch (e) {
    const msg = String(e?.message || "");

    if (msg === "FETCH_NOT_HTML") {
      return res.status(422).json({
        error: { code: "NOT_HTML", message: "La ressource n'est pas une page HTML" },
      });
    }
    if (msg.startsWith("FETCH_HTTP_")) {
      return res.status(502).json({
        error: { code: "FETCH_FAILED", message: `Erreur HTTP lors du fetch: ${msg}` },
      });
    }
    if (msg.includes("aborted")) {
      return res.status(504).json({
        error: { code: "TIMEOUT", message: "Timeout lors du fetch (12s)" },
      });
    }

    return res.status(502).json({
      error: { code: "UNKNOWN", message: "Impossible d'analyser cette page" },
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ API lancée sur http://localhost:${PORT}`);
});
