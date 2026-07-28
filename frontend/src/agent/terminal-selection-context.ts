import { t } from '../i18n';

export interface TerminalSelectionContext {
  content: string;
  sourceLabel: string;
  lineCount: number;
  characterCount: number;
}

/**
 * 创建终端选区快照。保留选区原文，不做静默截断或空白改写。
 */
export function createTerminalSelectionContext(
  content: string,
  sourceLabel: string,
): TerminalSelectionContext | null {
  if (!content.trim()) return null;

  return {
    content,
    sourceLabel: sourceLabel.trim(),
    lineCount: content.split(/\r\n|\r|\n/).length,
    characterCount: content.length,
  };
}

/**
 * 将用户问题与终端选区组合为模型请求，并明确选区只是非可信数据。
 */
export function buildTerminalSelectionMessage(
  question: string,
  context: TerminalSelectionContext,
): string {
  return t('agent.selectionContextPrompt', {
    source: context.sourceLabel || t('agent.selectionUnknownSource'),
    content: context.content,
    question: question.trim(),
  });
}
