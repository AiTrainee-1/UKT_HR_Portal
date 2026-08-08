// Loading animation supplied by the user for the Employee Attendance Search
// section (Staff/Production Attendance pages) -ported from their
// styled-components snippet to a scoped <style> tag (same reasoning as
// SpeederLoader: this codebase doesn't depend on styled-components).
// Customized per the user's request: "UKTextiles" is static, and the
// cycling word cycles through attendance-relevant terms instead of the
// original placeholder words.
export function AttendanceLoader() {
  return (
    <div className="spinnerContainer">
      <div className="spinner" />
      <div className="loader">
        <p>UKTextiles</p>
        <div className="words">
          <span className="word">attendance data</span>
          <span className="word">late detection</span>
          <span className="word">absent</span>
          <span className="word">present</span>
          <span className="word">shift</span>
          <span className="word">attendance data</span>
        </div>
      </div>
      <style>{`
        .spinnerContainer {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 24px 0;
        }

        .spinner {
          width: 56px;
          height: 56px;
          display: grid;
          border: 4px solid #0000;
          border-radius: 50%;
          border-right-color: #299fff;
          animation: tri-spinner 1s infinite linear;
        }

        .spinner::before,
        .spinner::after {
          content: "";
          grid-area: 1/1;
          margin: 2px;
          border: inherit;
          border-radius: 50%;
          animation: tri-spinner 2s infinite;
        }

        .spinner::after {
          margin: 8px;
          animation-duration: 3s;
        }

        @keyframes tri-spinner {
          100% {
            transform: rotate(1turn);
          }
        }

        .loader {
          color: #4a4a4a;
          font-family: "Poppins", sans-serif;
          font-weight: 500;
          font-size: 20px;
          box-sizing: content-box;
          height: 32px;
          padding: 10px 10px;
          display: flex;
          border-radius: 8px;
        }

        .words {
          overflow: hidden;
        }

        .word {
          display: block;
          height: 100%;
          padding-left: 6px;
          color: #299fff;
          animation: cycle-words 6s infinite;
        }

        @keyframes cycle-words {
          12% {
            transform: translateY(-105%);
          }
          20% {
            transform: translateY(-100%);
          }
          32% {
            transform: translateY(-205%);
          }
          40% {
            transform: translateY(-200%);
          }
          52% {
            transform: translateY(-305%);
          }
          60% {
            transform: translateY(-300%);
          }
          72% {
            transform: translateY(-405%);
          }
          80% {
            transform: translateY(-400%);
          }
          92% {
            transform: translateY(-505%);
          }
          100% {
            transform: translateY(-500%);
          }
        }
      `}</style>
    </div>
  );
}
