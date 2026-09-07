"use client";

const WEEKDAY_LABELS = ["M", "S", "S", "R", "K", "J", "S"]; // Minggu Senin Selasa Rabu Kamis Jumat Sabtu
const MONTH_LABELS = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

function pad(n) { return String(n).padStart(2, "0"); }

// A plain month-grid date picker — no library, matches this app's minimal-
// dependency style. `month` is "YYYY-MM" (the month currently displayed);
// `markedDates` is a Set of "YYYY-MM-DD" to highlight green (has data).
export default function MiniCalendar({ month, onMonthChange, selectedDate, markedDates, todayDate, onSelectDate }) {
  const [yearStr, monthStr] = month.split("-");
  const year = Number(yearStr), mo = Number(monthStr); // mo is 1-12
  const firstWeekday = new Date(year, mo - 1, 1).getDay(); // 0 = Minggu
  const daysInMonth = new Date(year, mo, 0).getDate();

  function shiftMonth(delta) {
    const d = new Date(year, mo - 1 + delta, 1);
    onMonthChange(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  }

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(day);

  return (
    <div className="mini-calendar">
      <div className="mini-calendar-header">
        <button type="button" onClick={() => shiftMonth(-1)} aria-label="Bulan sebelumnya">‹</button>
        <span>{MONTH_LABELS[mo - 1]} {year}</span>
        <button type="button" onClick={() => shiftMonth(1)} aria-label="Bulan berikutnya">›</button>
      </div>
      <div className="mini-calendar-weekdays">
        {WEEKDAY_LABELS.map((w, i) => <span key={i}>{w}</span>)}
      </div>
      <div className="mini-calendar-grid">
        {cells.map((day, i) => {
          if (day == null) return <span className="mini-calendar-cell" key={`blank-${i}`} />;
          const iso = `${year}-${pad(mo)}-${pad(day)}`;
          const classes = ["mini-calendar-cell", "mini-calendar-day"];
          if (markedDates.has(iso)) classes.push("has-data");
          if (iso === selectedDate) classes.push("selected");
          if (iso === todayDate) classes.push("is-today");
          return (
            <button type="button" key={iso} className={classes.join(" ")} onClick={() => onSelectDate(iso)}>
              {day}
            </button>
          );
        })}
      </div>
      <div className="mini-calendar-legend">
        <span className="mini-calendar-legend-item"><span className="mini-calendar-dot has-data" /> ada data</span>
        <span className="mini-calendar-legend-item"><span className="mini-calendar-dot is-today" /> hari ini</span>
      </div>
    </div>
  );
}
