import { genreById } from "../shared/catalog.js";
import { mixLine } from "../shared/orchestrator.js";
import { storyTitle } from "../shared/story.js";

/** Готовит рассказ к скачиванию в Markdown или простом тексте. */
export function exportStory(story, format) {
  const title = storyTitle(story);
  const scenes = story.scenes.filter((scene) => scene.content.trim());
  const meta = `${genreById(story.genreId)?.name ?? ""} · ${mixLine(story.wizard.subgenres)}`;
  const safe = title.replace(/[\\/:*?"<>|\n]+/g, " ").trim().slice(0, 80) || "rasskaz";

  if (format === "txt") {
    const body = [title.toUpperCase(), meta, "", scenes.map((scene) => scene.content).join("\n\n* * *\n\n"), ""].join("\n");
    return { body, ext: "txt", name: `${safe}.txt`, type: "text/plain; charset=utf-8" };
  }

  const parts = [`# ${title}`, `*${meta}*`];
  if (story.review?.blurb) parts.push(`> ${story.review.blurb}`);
  parts.push(scenes.map((scene) => scene.content).join("\n\n* * *\n\n"));
  return { body: `${parts.join("\n\n")}\n`, ext: "md", name: `${safe}.md`, type: "text/markdown; charset=utf-8" };
}
