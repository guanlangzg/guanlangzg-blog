import { ImageResponse } from 'next/og';

export const runtime = 'edge';

const DEFAULT_TITLE = '观澜志';
const DEFAULT_DESCRIPTION = '记录值得回看的文章与实用导航。';

function getSearchParam(url: string, key: string, fallback: string): string {
    const value = new URL(url).searchParams.get(key)?.trim();

    return value || fallback;
}

function limitText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

export function GET(request: Request) {
    const title = limitText(getSearchParam(request.url, 'title', DEFAULT_TITLE), 72);
    const description = limitText(getSearchParam(request.url, 'description', DEFAULT_DESCRIPTION), 108);

    return new ImageResponse(
        (
            <div
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    background: '#f7f8f5',
                    color: '#1a1917',
                    padding: '72px',
                    border: '1px solid #e3e6de',
                    fontFamily: 'Arial, "Microsoft YaHei", sans-serif',
                }}
            >
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '16px',
                        color: '#b85c38',
                        fontSize: '24px',
                        letterSpacing: 0,
                    }}
                >
                    <div
                        style={{
                            width: '18px',
                            height: '18px',
                            borderRadius: '4px',
                            background: '#b85c38',
                        }}
                    />
                    观澜志
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                    <h1
                        style={{
                            margin: 0,
                            maxWidth: '920px',
                            fontSize: '68px',
                            lineHeight: 1.08,
                            fontWeight: 700,
                            letterSpacing: 0,
                        }}
                    >
                        {title}
                    </h1>
                    <p
                        style={{
                            margin: 0,
                            maxWidth: '780px',
                            color: '#5f5a54',
                            fontSize: '30px',
                            lineHeight: 1.35,
                        }}
                    >
                        {description}
                    </p>
                </div>
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        color: '#8b8378',
                        fontSize: '22px',
                    }}
                >
                    <span>观澜志文章</span>
                    <span>公开内容与导航</span>
                </div>
            </div>
        ),
        {
            width: 1200,
            height: 630,
        }
    );
}
