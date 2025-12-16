import express from "express";
import { fetch } from "undici";
import * as cheerio from "cheerio";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({
  origin: [
    "https://marie-redacweb.fr",
    "https://www.marie-redacweb.fr"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));


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
  return stripAccents(cleanText(s).toLowerCase()).replace(/[^\p{L}\p{N}\s]/gu, "");
}

function containsKeyword(text, keyword) {
  const t = normalizeForMatch(text);
  const k = normalizeForMatch(keyword);
  if (!t || !k) return false;
  return t.includes(k);
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

function statusGlobalFromChecks(checks) {
  const structurants = new Set(["title", "h1", "keyword_structure"]);
  const hasRedStructurant = checks.some(
    (c) => c.status === "red" && structurants.has(c.id)
  );
  if (hasRedStructurant) return "red";
  const hasRed = checks.some((c) => c.status === "red");
  if (hasRed) return "orange"; // rouge non bloquant hors structurants -> orange global
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
      body: "Quelques ajustements peuvent améliorer la clarté de ta page.",
      cta: "show",
    };
  }
  return {
    title: "🔴 Le sujet de ta page n’est pas encore clair pour Google ni pour tes visiteurs.",
    body:
      "Rien de grave : ce sont des points structurants à revoir.\n👉 Si tu veux en parler et savoir par où commencer, tu peux réserver un appel découverte offert.",
    cta: "show",
  };
}

function buildMessagesForCheck(checkId, status, extra = {}) {
  // Liens / CTA (tu pourras remplacer par tes URLs)
  const SERP_SIMULATOR_HINT = "👉 Tu peux retravailler ce point avec le simulateur de SERP.";
  const CALL_HINT = "👉 Si tu veux en parler lors d’un appel découverte offert, je t’accueille avec plaisir.";

  switch (checkId) {
    case "title": {
      if (status === "green") {
        return {
          message:
            "Ton title est présent, clair et bien dimensionné.\nIl aide Google à comprendre le sujet de ta page.",
          action: "",
        };
      }
      if (status === "orange") {
        return {
          message:
            "Ton title est présent, mais sa longueur peut être optimisée.\nTrop court ou trop long, il risque d’être tronqué dans les résultats de recherche.",
          action: SERP_SIMULATOR_HINT,
        };
      }
      return {
        message:
          "Aucun title clair n’a été détecté.\nC’est un élément essentiel pour indiquer le sujet principal de ta page.",
        action: "👉 Priorité : écrire un title qui intègre naturellement ta requête clé.\n" + SERP_SIMULATOR_HINT,
      };
    }

    case "meta_description": {
      if (status === "green") {
        return {
          message:
            "Une meta description est bien définie.\nElle donne envie de cliquer et contextualise ta page.",
          action: "",
        };
      }
      if (status === "orange") {
        return {
          message:
            "Ta meta description est présente, mais sa longueur peut être améliorée.\nElle risque de ne pas s’afficher correctement dans Google.",
          action: SERP_SIMULATOR_HINT,
        };
      }
      return {
        message:
          "Aucune meta description n’a été détectée.\nCe n’est pas bloquant pour le référencement, mais dommage pour le taux de clic.",
        action: SERP_SIMULATOR_HINT,
      };
    }

    case "h1": {
      if (status === "green") {
        return {
          message:
            "Ton H1 est unique et bien aligné avec le sujet de ta page.\nIl pose clairement le cadre.",
          action: "",
        };
      }
      if (status === "orange") {
        return {
          message:
            "Un H1 est présent, mais il pourrait être plus précis ou mieux aligné avec ta requête clé.",
          action: "",
        };
      }
      return {
        message:
          "Aucun H1 clair (ou plusieurs H1) ont été détectés.\nCela rend le sujet de la page difficile à identifier.",
        action: "👉 Priorité : un seul H1, centré sur l’idée principale.",
      };
    }

    case "keyword_structure": {
      if (status === "green") {
        return {
          message:
            "Ta requête clé est présente aux bons endroits de la page.\nLa structure aide clairement à comprendre le sujet traité.",
          action: "",
        };
      }
      if (status === "orange") {
        const missing = extra?.missing?.length ? extra.missing.join(", ") : "un endroit clé";
        return {
          message:
            "Ta requête clé est présente, mais elle manque à certains endroits clés.\nPar exemple : " +
            missing +
            ".",
          action: "👉 Astuce : renforce la cohérence en la réintégrant naturellement là où elle manque.",
        };
      }
      return {
        message:
          "La requête clé n’est pas clairement identifiable dans la structure de ta page.\nGoogle peut avoir du mal à comprendre le sujet principal.",
        action: "👉 Priorité : clarifier le fil conducteur de ta page.\n" + CALL_HINT,
      };
    }

    case "structure": {
      if (status === "green") {
        return {
          message:
            "La page est bien structurée.\nLes sous-titres facilitent la lecture et la compréhension.",
          action: "",
        };
      }
      if (status === "orange") {
        return {
          message:
            "Une structure est présente, mais elle pourrait être plus lisible ou mieux organisée.",
          action: "",
        };
      }
      return {
        message:
          "La page manque de structure claire.\nElle ressemble davantage à un bloc de texte continu.",
        action: "👉 Action simple : découper le contenu en sections logiques avec des H2.",
      };
    }

    case "images_alt": {
      if (status === "green") {
        return {
          message:
            "Les images sont bien utilisées et leurs attributs alt sont renseignés.\nC’est un bon point pour l’accessibilité et la compréhension du contenu.",
          action: "",
        };
      }
      if (status === "orange") {
        return {
          message:
            "Des images sont présentes, mais certains attributs alt manquent.",
          action: "👉 Action simple : décrire brièvement chaque image avec des mots humains.",
        };
      }
      return {
        message:
          "Aucune image n’a été détectée sur la page.\nUne image peut aider à aérer et contextualiser le contenu.",
        action: "",
      };
    }

    case "readability": {
      if (status === "green") {
        return {
          message:
            "Le texte est agréable à lire.\nLes paragraphes sont bien aérés.",
          action: "",
        };
      }
      if (status === "orange") {
        return {
          message:
            "Certains passages sont un peu longs et pourraient être allégés.",
          action: "",
        };
      }
      return {
        message:
          "La lecture est difficile : les paragraphes sont trop denses.",
        action: "👉 Astuce : raccourcir, aérer, simplifier.",
      };
    }

    case "lexical": {
      if (status === "green") {
        return {
          message:
            "Le vocabulaire utilisé aide à bien contextualiser le sujet de la page.\nLe champ lexical est cohérent avec ta requête clé.",
          action: "",
        };
      }
      if (status === "orange") {
        return {
          message:
            "Le sujet est compris, mais le champ lexical pourrait être enrichi.",
          action: "👉 Action simple : ajouter des mots naturellement liés à ton sujet.",
        };
      }
      return {
        message:
          "Le vocabulaire est trop pauvre pour bien poser le contexte de ta page.",
        action: "👉 Priorité : enrichir le contenu sans sur-optimiser.",
      };
    }

    default:
      return { message: "", action: "" };
  }
}

function computeChecks(extracted, keyword) {
  const checks = [];

  // 1) Title (présence + longueur)
  const title = extracted.title || "";
  const titleLen = title.length;
  let titleStatus = "red";
  if (titleLen > 0) {
    titleStatus = titleLen >= 45 && titleLen <= 60 ? "green" : "orange";
  }
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

  // 2) Meta description (présence + longueur)
  const meta = extracted.meta_description || "";
  const metaLen = meta.length;
  let metaStatus = "red";
  if (metaLen > 0) {
    metaStatus = metaLen >= 140 && metaLen <= 160 ? "green" : "orange";
  }
  {
    const { message, action } = buildMessagesForCheck("meta_description", metaStatus);
    checks.push({
      id: "meta_description",
      label: "Meta description — invitation au clic",
      status: metaStatus,
      message,
      action,
      data: { length: metaLen, value: meta },
    });
  }

  // 3) H1 unique + aligné (keyword dans H1)
  const h1s = extracted.h1s || [];
  let h1Status = "red";
  if (h1s.length === 1) {
    h1Status = containsKeyword(h1s[0], keyword) ? "green" : "orange";
  } else {
    h1Status = "red";
  }
  {
    const { message, action } = buildMessagesForCheck("h1", h1Status);
    checks.push({
      id: "h1",
      label: "H1 — sujet principal de la page",
      status: h1Status,
      message,
      action,
      data: { count: h1s.length, values: h1s },
    });
  }

  // 4) Keyword dans la structure : H1 / intro / H2 / conclusion
  const intro = extracted.intro || "";
  const conclusion = extracted.conclusion || "";
  const h2s = extracted.h2s || [];

  const okH1 = h1s.length ? containsKeyword(h1s.join(" "), keyword) : false;
  const okIntro = intro ? containsKeyword(intro, keyword) : false;
  const okH2 = h2s.length ? h2s.some((h2) => containsKeyword(h2, keyword)) : false;
  const okConc = conclusion ? containsKeyword(conclusion, keyword) : false;

  const missing = [];
  if (!okH1) missing.push("H1");
  if (!okIntro) missing.push("intro");
  if (!okH2) missing.push("H2");
  if (!okConc) missing.push("conclusion");

  const okCount = [okH1, okIntro, okH2, okConc].filter(Boolean).length;
  let ksStatus = "red";
  if (okCount === 4) ksStatus = "green";
  else if (okCount >= 2) ksStatus = "orange";
  else ksStatus = "red";

  {
    const { message, action } = buildMessagesForCheck("keyword_structure", ksStatus, { missing });
    checks.push({
      id: "keyword_structure",
      label: "Requête clé dans la structure",
      status: ksStatus,
      message,
      action,
      data: { ok_h1: okH1, ok_intro: okIntro, ok_h2: okH2, ok_conclusion: okConc, missing },
    });
  }

  // 5) Structure globale (H2 count)
  const h2Count = h2s.length;
  let structureStatus = "red";
  if (h2Count >= 2) structureStatus = "green";
  else if (h2Count === 1) structureStatus = "orange";
  else structureStatus = "red";

  {
    const { message, action } = buildMessagesForCheck("structure", structureStatus);
    checks.push({
      id: "structure",
      label: "Structure globale de la page",
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
  if (imgCount === 0) imgStatus = "red";
  else if (missingAlt > 0) imgStatus = "orange";
  else imgStatus = "green";

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
  else readStatus = "green";

  {
    const { message, action } = buildMessagesForCheck("readability", readStatus);
    checks.push({
      id: "readability",
      label: "Lisibilité du texte",
      status: readStatus,
      message,
      action,
      data: {
        avg_words_per_paragraph: extracted.avg_words_per_paragraph || 0,
        long_paragraphs_count: longP,
      },
    });
  }

  // 8) Champ lexical (V1 simple)
  // Très basique : mots clés génériques + mots de la requête (>=4 lettres)
  const generic = ["google", "referencement", "seo", "site", "page", "contenu", "visibilite"];
  const kwParts = normalizeForMatch(keyword)
    .split(" ")
    .map((w) => w.trim())
    .filter((w) => w.length >= 4);
  const expected = Array.from(new Set([...generic, ...kwParts]));

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
  else lexStatus = "red";

  {
    const { message, action } = buildMessagesForCheck("lexical", lexStatus);
    checks.push({
      id: "lexical",
      label: "Champ lexical lié à la requête clé",
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
    const h1s = $("h1").map((_, el) => cleanText($(el).text())).get();
    const h2s = $("h2").map((_, el) => cleanText($(el).text())).get();

    const intro = extractFirstParagraph($);
    const conclusion = extractLastParagraph($);
    const paragraphs = extractParagraphs($);
    const images = extractImages($);

    const paragraphWordCounts = paragraphs.map(wordsCount);
    const longParagraphsCount = paragraphWordCounts.filter((n) => n > 120).length;
    const avgWordsPerParagraph =
      paragraphWordCounts.length
        ? Math.round(
            paragraphWordCounts.reduce((a, b) => a + b, 0) /
              paragraphWordCounts.length
          )
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
