function formatTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    const options = { timeZone: 'Asia/Tokyo', hour: 'numeric', minute: 'numeric', hour12: false };
    const formatter = new Intl.DateTimeFormat('ja-JP', options);
    const parts = formatter.formatToParts(date);
    
    console.log('Parts:', JSON.stringify(parts));
    
    const hours = parseInt(parts.find(p => p.type === 'hour').value);
    const minutes = parseInt(parts.find(p => p.type === 'minute').value);
    
    const ampm = hours < 12 ? '午前' : '午後';
    const displayHours = hours % 12 || 12;
    return `${ampm}${displayHours}時${minutes}分`;
}

console.log(formatTime('2024-04-17T23:15:10+09:00'));
