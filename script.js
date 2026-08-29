const sections = document.querySelectorAll(".fade");

window.addEventListener("scroll", () => {

    sections.forEach(section => {

        const top = section.getBoundingClientRect().top;

        if(top < window.innerHeight * 0.8){
            section.classList.add("show");
        }

    });

});

window.dispatchEvent(new Event("scroll"));