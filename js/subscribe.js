document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('#subscribe_signup form').forEach(function (form) {
        var wrapper = form.parentElement;
        var message = document.createElement('p');
        message.className = 'subscribe-message';
        message.hidden = true;
        wrapper.appendChild(message);

        form.addEventListener('submit', function (event) {
            event.preventDefault();

            var button = form.querySelector('button');
            button.disabled = true;

            var params = new URLSearchParams(new FormData(form));

            fetch(form.action, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString(),
            }).finally(function () {
                form.style.display = 'none';
                message.hidden = false;
                message.textContent = "Thanks for subscribing!";
            });
        });
    });
});
