import type { YoutubeWidget } from '../../../shared/widgets.js';

export function YoutubeCard({ data }: { data: YoutubeWidget }) {
  return (
    <div className="widget widget--youtube">
      <div className="widget__head">
        <span className="widget__kind">youtube</span>
      </div>
      <div className="widget__body">
        <a
          href={data.url}
          target="_blank"
          rel="noreferrer"
          className="yt__thumb-link"
        >
          <img
            src={data.thumbnailUrl}
            alt=""
            className="yt__thumb"
            referrerPolicy="no-referrer"
          />
        </a>
        <div className="yt__info">
          <div className="yt__title">{data.title}</div>
          {data.channel && <div className="yt__channel">{data.channel}</div>}
        </div>
      </div>
    </div>
  );
}
