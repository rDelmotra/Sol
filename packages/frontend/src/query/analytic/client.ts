import type { AnalyticProgram } from './types';

export async function compileNaturalLanguageQuery(query: string): Promise<AnalyticProgram> {
  const response = await fetch(`/api/query/compile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    let errMessage = 'Failed to compile query';
    try {
      const data = await response.json();
      if (data.error) errMessage = data.error;
    } catch {
      // ignore
    }
    throw new Error(errMessage);
  }

  return response.json() as Promise<AnalyticProgram>;
}
