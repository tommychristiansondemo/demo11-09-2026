import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Renders Markdown from the knowledge document or the model. Raw HTML is never rendered (skipHtml),
// and links open safely in a new tab.
export function Md({ children }: { children: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml
        components={{
          a: ({ href, children: c }) => <a href={href} target="_blank" rel="noopener noreferrer">{c}</a>,
          table: ({ children: c }) => <div className="table-wrap"><table>{c}</table></div>,
        }}>
        {children}
      </Markdown>
    </div>
  );
}
